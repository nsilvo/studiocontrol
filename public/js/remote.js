/**
 * public/js/remote.js
 *
 * Wrapped in DOMContentLoaded so all getElementById(...) calls run after the DOM is ready.
 * Implements:
 *  - Step 1: Prompt for name.
 *  - Step 2: After name, show main UI & connect WebSocket/RTC.
 *  - Wait for 'joined' to set remoteId.
 *  - Wait for 'start-call' from studio to initiate WebRTC.
 *  - Test tone, mute toggle, local PPM meter, chat, auto-reconnect.
 */

document.addEventListener('DOMContentLoaded', () => {
  const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;

  let ws = null;
  let remoteId = null;
  let displayName = null;

  let pc = null;
  let localStream = null;
  let audioSender = null;
  let audioCtx = null;
  let analyserNode = null;
  let hasLoggedBitrateChange = false;

  let currentMode = 'speech';
  let currentBitrate = 16000;

  // GLITS test tone state
  let isToneOn = false;
  let toneOsc = null;
  let toneGain = null;

  // DOM elements (all exist after DOMContentLoaded)
  const nameStepDiv    = document.getElementById('name-step');
  const nameInput      = document.getElementById('nameInput');
  const nameSubmitBtn  = document.getElementById('nameSubmitBtn');

  const mainUiDiv      = document.getElementById('main-ui');
  const statusDiv      = document.getElementById('status');
  const toneBtn        = document.getElementById('toneBtn');
  const muteSelfBtn    = document.getElementById('muteSelfBtn');
  const meterCanvas    = document.getElementById('meter-canvas');

  const chatWindowEl   = document.getElementById('chatWindow');
  const chatInputEl    = document.getElementById('chatInput');
  const sendChatBtn    = document.getElementById('sendChatBtn');

  // ────────────────────────────────────────────────────────────────────────
  // 1) NAME SUBMISSION FLOW
  // ────────────────────────────────────────────────────────────────────────
  nameSubmitBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) {
      alert('Please enter a display name.');
      return;
    }
    displayName = name;
    // Hide name‐step, show main UI
    nameStepDiv.classList.add('hidden');
    mainUiDiv.classList.remove('hidden');
    statusDiv.textContent = 'Connecting to studio…';
    initializeWebSocket();
  };

  // ────────────────────────────────────────────────────────────────────────
  // 2) WEBSOCKET SETUP & MESSAGE HANDLING
  // ────────────────────────────────────────────────────────────────────────
  function initializeWebSocket() {
    ws = createReconnectingWebSocket(WS_URL);

    ws.onOpen = () => {
      // Tell server “I am a remote”
      ws.send(JSON.stringify({
        type: 'join',
        role: 'remote',
        name: displayName
      }));
    };

    ws.onMessage = raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        console.error('Invalid JSON from server:', e);
        return;
      }
      handleSignalingMessage(msg);
    };

    ws.onClose = () => {
      statusDiv.textContent = 'WebSocket closed. Reconnecting in 5 seconds…';
      console.warn('WebSocket closed. Awaiting reconnect.');
      // createReconnectingWebSocket will try to reconnect automatically
    };

    ws.onError = err => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        // { type: "joined", id: "<remoteId>" }
        remoteId = msg.id;
        console.log('Assigned remoteId:', remoteId);
        statusDiv.textContent = '🔑 Remote ID set. Awaiting call from studio…';
        break;

      case 'start-call':
        // Server tells us: studio clicked “Call”
        if (!remoteId) {
          console.error('Received start-call before joined.');
          return;
        }
        statusDiv.textContent = '📞 Starting WebRTC call…';
        startCall();
        break;

      case 'answer':
        // { type: "answer", sdp: "<sdp>" }
        handleAnswer(msg.sdp);
        break;

      case 'candidate':
        // { type: "candidate", candidate: {...} }
        handleCandidate(msg.candidate);
        break;

      case 'mode-update':
        // { type: "mode-update", mode: "speech"|"music" }
        handleModeUpdate(msg.mode);
        break;

      case 'bitrate-update':
        // { type: "bitrate-update", bitrate: <number> }
        handleBitrateUpdate(msg.bitrate);
        break;

      case 'mute-update':
        // { type: "mute-update", muted: true|false }
        handleMuteUpdate(msg.muted);
        break;

      case 'kick':
        alert('❌ You have been kicked by the studio.');
        ws.close();
        break;

      case 'chat':
        // { type: "chat", fromId:"<studioId>", text:"<message>" }
        appendChatMessage(msg.fromId || 'Studio', msg.text);
        break;

      default:
        // Ignore unknown types
        break;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3) WEBRTC CALL SETUP
  // ────────────────────────────────────────────────────────────────────────
  async function startCall() {
    try {
      // 3.1 Get userMedia with channelCount based on currentMode
      const constraints = {
        audio: {
          channelCount: currentMode === 'music' ? 2 : 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true
        }
      };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      setupPPMMeter(localStream);

      // 3.2 Create RTCPeerConnection
      pc = new RTCPeerConnection(getRTCConfig());

      // 3.3 Add local tracks to PC
      localStream.getTracks().forEach(track => {
        audioSender = pc.addTrack(track, localStream);
      });

      // 3.4 When ICE candidates are found, send them to studio
      pc.onicecandidate = e => {
        if (e.candidate) {
          ws.send(JSON.stringify({
            type: 'candidate',
            from: remoteId,
            target: 'studio',
            candidate: e.candidate
          }));
        }
      };

      // 3.5 Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 3.6 Send offer to studio
      ws.send(JSON.stringify({
        type: 'offer',
        from: remoteId,
        sdp: offer.sdp
      }));

      statusDiv.textContent = '📨 Offer sent. Awaiting answer…';
    } catch (err) {
      console.error('Error during startCall():', err);
      statusDiv.textContent = '❌ Error starting call. Check console.';
    }
  }

  async function handleAnswer(sdp) {
    if (!pc) {
      console.error('handleAnswer(): PC is not initialized.');
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      statusDiv.textContent = '✅ Call established with studio.';
    } catch (err) {
      console.error('Error setting remote description:', err);
    }
  }

  async function handleCandidate(candidate) {
    if (!pc) {
      console.error('handleCandidate(): PC is not initialized.');
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4) RESPOND TO STUDIO CONTROLS
  // ────────────────────────────────────────────────────────────────────────
  function handleModeUpdate(mode) {
    currentMode = mode;
    console.log(`Mode updated by studio: ${mode}`);
    statusDiv.textContent = `🔄 Mode switched to ${mode}. Reconnect to apply channel change.`;
  }

  async function handleBitrateUpdate(bitrate) {
    currentBitrate = bitrate;
    if (audioSender) {
      const params = audioSender.getParameters();
      if (!params.encodings || !params.encodings.length) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = bitrate;
      try {
        await audioSender.setParameters(params);
        if (!hasLoggedBitrateChange) {
          console.log(`Audio bitrate set to ${bitrate} bps`);
          hasLoggedBitrateChange = true;
        }
      } catch (e) {
        console.warn('Failed to set bitrate parameters:', e);
      }
    }
  }

  function handleMuteUpdate(muted) {
    if (localStream) {
      localStream.getAudioTracks().forEach(t => (t.enabled = !muted));
      statusDiv.textContent = muted
        ? '🔇 You have been muted by the studio.'
        : '🔈 You have been unmuted by the studio.';
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5) CHAT
  // ────────────────────────────────────────────────────────────────────────
  function appendChatMessage(sender, text) {
    const msgEl = document.createElement('div');
    msgEl.textContent = `[${sender}]: ${text}`;
    chatWindowEl.appendChild(msgEl);
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  }

  sendChatBtn.onclick = () => {
    const text = chatInputEl.value.trim();
    if (!text) return;
    ws.send(JSON.stringify({
      type: 'chat',
      fromRole: 'remote',
      fromId: remoteId,
      target: 'studio',
      text
    }));
    appendChatMessage('You', text);
    chatInputEl.value = '';
  };

  // ────────────────────────────────────────────────────────────────────────
  // 6) GLITS TEST TONE & MUTE TOGGLE
  // ────────────────────────────────────────────────────────────────────────
  toneBtn.onclick = () => {
    if (!audioCtx) audioCtx = new AudioContext();

    if (!isToneOn) {
      // Start 1 kHz test tone
      toneOsc = audioCtx.createOscillator();
      toneGain = audioCtx.createGain();
      toneOsc.frequency.value = 1000;
      toneGain.gain.value = 0.1;
      toneOsc.connect(toneGain).connect(audioCtx.destination);
      toneOsc.start();

      // Replace mic track with tone track
      if (audioSender) {
        const toneDestination = audioCtx.createMediaStreamDestination();
        const osc = audioCtx.createOscillator();
        osc.frequency.value = 1000;
        osc.connect(toneDestination);
        osc.start();
        audioSender.replaceTrack(toneDestination.stream.getAudioTracks()[0]);
      }

      toneBtn.textContent = 'Stop Test Tone';
      isToneOn = true;
    } else {
      // Stop tone, restore mic track
      toneOsc.stop();
      toneOsc.disconnect();
      toneGain.disconnect();
      if (localStream && audioSender) {
        audioSender.replaceTrack(localStream.getAudioTracks()[0]);
      }
      toneBtn.textContent = 'Start Test Tone';
      isToneOn = false;
    }
  };

  muteSelfBtn.onclick = () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    muteSelfBtn.textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
  };

  // ────────────────────────────────────────────────────────────────────────
  // 7) LOCAL PPM METER
  // ────────────────────────────────────────────────────────────────────────
  function setupPPMMeter(stream) {
    if (!audioCtx) audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = createPPMMeter(audioCtx, source, meterCanvas);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 8) CLEANUP ON UNLOAD
  // ────────────────────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    if (pc) pc.close();
    if (ws) ws.close();
  });
});
