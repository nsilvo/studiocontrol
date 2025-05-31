/**
 * public/js/remote.js
 *
 * - Two‐step remote flow:
 *    1. Prompt for name (Step 1).
 *    2. Once name is submitted, reveal main UI, show displayName, set up a
 *       stereo mic capture with a –14 dBFS compressor, and start WebSocket/RTC.
 *
 * - Listens for studio “mode‐update” messages to switch between:
 *     • speech → mono (1 channel)
 *     • music  → stereo (2 channels)
 *   Automatically re‐negotiates the connection when mode changes.
 *
 * - Listens for studio “bitrate-update” messages to adjust encoder bitrate.
 *
 * - All outgoing audio is passed through a DynamicsCompressorNode (threshold –14 dBFS) 
 *   to approximate a –14 LUFS limit.
 *
 * - PPM meter displays two bars (left + right). If only 1 channel is active,
 *   it displays the same data on both bars (mono).
 */

document.addEventListener('DOMContentLoaded', () => {
  // TURN/STUN configuration
  const ICE_CONFIG = {
    iceServers: [
      {
        urls: ['turn:turn.nkpa.co.uk:3478'],
        username: 'webrtcuser',
        credential: 'uS2h$2JW!hL3!E9yb1N1',
      },
    ],
  };

  const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
  let ws = null;
  let pc = null;
  let localStream = null;       // Raw mic MediaStream
  let processedStream = null;   // After compressor
  let audioSender = null;
  let remoteId = null;
  let displayName = '';
  let currentMode = 'music';    // Default: 'music' → stereo, studio can override to 'speech'
  let hasLoggedBitrate = false;
  let isMuted = false;
  let isTone = false;

  // GLITS‐tone nodes (always stereo)
  let toneContext = null;
  let toneOsc = null;
  let toneGain = null;

  // AudioContext for compression + metering
  let audioContext = null;
  let analyserL = null;
  let analyserR = null;

  // DOM elements
  const nameStepDiv   = document.getElementById('name-step');
  const nameInput     = document.getElementById('nameInput');
  const nameSubmitBtn = document.getElementById('nameSubmitBtn');
  const mainUiDiv     = document.getElementById('main-ui');
  const displayNameDiv= document.getElementById('display-name');
  const statusSpan    = document.getElementById('connStatus');
  const muteBtn       = document.getElementById('muteSelfBtn');
  const toneBtn       = document.getElementById('toneBtn');
  const listenBtn     = document.getElementById('listenStudioBtn');
  const meterCanvas   = document.getElementById('meter-canvas');
  const chatWindowEl  = document.getElementById('chatWindow');
  const chatInputEl   = document.getElementById('chatInput');
  const sendChatBtn   = document.getElementById('sendChatBtn');

  // ────────────────────────────────────────────────────────────────────────
  // 1) STEP 1: NAME SUBMISSION
  // ────────────────────────────────────────────────────────────────────────
  nameSubmitBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) {
      alert('Please enter your name.');
      return;
    }
    displayName = name;
    nameStepDiv.classList.add('hidden');
    mainUiDiv.classList.remove('hidden');
    displayNameDiv.textContent = `Name: ${displayName}`;
    statusSpan.textContent = 'Connecting WebSocket…';
    initWebSocket();
  };

  // ────────────────────────────────────────────────────────────────────────
  // 2) WEBSOCKET SETUP & MESSAGE HANDLING
  // ────────────────────────────────────────────────────────────────────────
  function initWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[remote] WS opened');
      statusSpan.textContent = 'WS connected. Joining…';
      ws.send(JSON.stringify({
        type: 'join',
        role: 'remote',
        name: displayName
      }));
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        console.error('[remote] Invalid JSON:', e);
        return;
      }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      console.warn('[remote] WS closed. Reconnecting in 5s…');
      statusSpan.textContent = 'WS disconnected. Reconnecting…';
      setTimeout(initWebSocket, 5000);
      if (pc) {
        pc.close();
        pc = null;
      }
    };

    ws.onerror = (err) => {
      console.error('[remote] WS error:', err);
      ws.close();
    };
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        // { type:'joined', id }
        remoteId = msg.id;
        console.log('[remote] Assigned ID:', remoteId);
        statusSpan.textContent = 'Waiting for studio call…';
        break;

      case 'start-call':
        // Received when studio clicks “Call”
        statusSpan.textContent = 'Starting WebRTC…';
        await startWebRTC();
        break;

      case 'answer':
        // { type:'answer', sdp }
        await handleAnswer(msg.sdp);
        break;

      case 'candidate':
        // { type:'candidate', candidate }
        await handleCandidate(msg.candidate);
        break;

      case 'mode-update':
        // { type:'mode-update', mode:'speech'|'music' }
        await applyMode(msg.mode);
        break;

      case 'bitrate-update':
        // { type:'bitrate-update', bitrate:<number> }
        setAudioBitrate(msg.bitrate);
        break;

      case 'mute-update':
        // { type:'mute-update', muted:true }
        handleMuteUpdate(msg.muted);
        break;

      case 'kick':
        alert('You have been kicked by the studio.');
        ws.close();
        break;

      case 'chat':
        // { type:'chat', from:'studio', text }
        appendChatMessage('Studio', msg.text);
        break;

      default:
        console.warn('[remote] Unknown message:', msg.type);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3) WEBRTC SETUP
  // ────────────────────────────────────────────────────────────────────────
  async function startWebRTC() {
    try {
      // 3.1 Get userMedia
      const constraints = {
        audio: {
          sampleRate: 48000,
          channelCount: currentMode === 'music' ? 2 : 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      setupPPMMeter(localStream);

      // 3.2 Create RTCPeerConnection
      pc = new RTCPeerConnection(ICE_CONFIG);

      // 3.3 Add local tracks
      localStream.getTracks().forEach(track => {
        audioSender = pc.addTrack(track, localStream);
      });

      // 3.4 ICE candidate handler
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(JSON.stringify({
            type: 'candidate',
            from: remoteId,
            target: 'studio',
            candidate: e.candidate
          }));
        }
      };

      // 3.5 Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 3.6 Send offer
      ws.send(JSON.stringify({
        type: 'offer',
        from: remoteId,
        sdp: offer.sdp
      }));
      statusSpan.textContent = 'Offer sent. Awaiting answer…';
    } catch (err) {
      console.error('[remote] startWebRTC error:', err);
      statusSpan.textContent = 'Error starting call.';
    }
  }

  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      statusSpan.textContent = 'Connected to studio.';
    } catch (e) {
      console.error('[remote] setRemoteDescription error:', e);
    }
  }

  async function handleCandidate(candidate) {
    if (!pc || !pc.remoteDescription) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[remote] addIceCandidate error:', e);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4) MODE & BITRATE CHANGES
  // ────────────────────────────────────────────────────────────────────────
  async function applyMode(mode) {
    if (mode !== 'speech' && mode !== 'music') return;
    if (mode === currentMode) return;
    currentMode = mode;

    // If PC isn't started yet, future startWebRTC will use updated mode
    if (!pc) {
      statusSpan.textContent = `Mode changed to ${mode}. Waiting to call.`;
      return;
    }

    // Otherwise, renegotiate:
    // 1) Stop old track
    if (audioSender && localStream) {
      pc.removeTrack(audioSender);
      audioSender = null;
    }
    // 2) Get new capture with updated channelCount
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: currentMode === 'music' ? 2 : 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      localStream = newStream;
      setupPPMMeter(localStream);
      processedStream = createCompressedStream(localStream);
      audioSender = pc.addTrack(processedStream.getAudioTracks()[0], processedStream);
      setAudioBitrate(currentBitrate);
      // 3) Renegotiate
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({
        type: 'offer',
        from: remoteId,
        sdp: offer.sdp
      }));
      statusSpan.textContent = `Mode switched to ${mode}. Renegotiated.`;
    } catch (e) {
      console.error('[remote] applyMode error:', e);
    }
  }

  function setAudioBitrate(bitrate) {
    if (!audioSender) {
      console.warn('[remote] Audio sender not ready for bitrate change');
      return;
    }
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    audioSender.setParameters(params)
      .then(() => {
        if (!hasLoggedBitrate) {
          console.log(`[remote] Audio bitrate set to ${bitrate} bps`);
          hasLoggedBitrate = true;
        }
        statusSpan.textContent = `Bitrate set to ${Math.round(bitrate/1000)} kbps`;
      })
      .catch(err => {
        console.warn('[remote] setParameters error:', err);
      });
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5) MUTE UPDATE FROM STUDIO
  // ────────────────────────────────────────────────────────────────────────
  function handleMuteUpdate(muted) {
    if (localStream) {
      localStream.getAudioTracks().forEach(t => (t.enabled = !muted));
      statusSpan.textContent = muted ? 'You have been muted.' : 'You are unmuted.';
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 6) CHAT
  // ────────────────────────────────────────────────────────────────────────
  function appendChatMessage(sender, text) {
    const div = document.createElement('div');
    div.textContent = `[${sender}]: ${text}`;
    chatWindowEl.appendChild(div);
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
  // 7) GLITS TEST TONE & MUTE SELF
  // ────────────────────────────────────────────────────────────────────────
  toneBtn.onclick = () => {
    if (!audioSender) {
      alert('Audio not yet sending.');
      return;
    }
    if (!isTone) {
      toneContext = new (window.AudioContext || window.webkitAudioContext)();
      toneGain = toneContext.createGain();
      toneGain.gain.value = 0.1;
      toneOsc = toneContext.createOscillator();
      toneOsc.frequency.value = 1000;
      toneOsc.connect(toneGain);
      const toneDest = toneContext.createMediaStreamDestination();
      toneGain.connect(toneDest);
      toneOsc.start();
      audioSender.replaceTrack(toneDest.stream.getAudioTracks()[0]);
      statusSpan.textContent = 'Sending test tone…';
      toneBtn.textContent = 'Stop Test Tone';
      isTone = true;
    } else {
      toneOsc.stop();
      toneOsc.disconnect();
      toneGain.disconnect();
      if (localStream) {
        audioSender.replaceTrack(localStream.getAudioTracks()[0]);
      }
      statusSpan.textContent = 'Test tone stopped.';
      toneBtn.textContent = 'Send GLITS Tone';
      isTone = false;
    }
  };

  muteBtn.onclick = () => {
    if (!audioSender || !localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    muteBtn.textContent = track.enabled ? 'Mute Myself' : 'Unmute Myself';
  };

  listenBtn.onclick = () => {
    // If studio audio is set up, toggle mute
    // There is no <audio> element here for studio feedback, so just alert if not connected
    alert('Listening to studio is not yet implemented on this page.');
  };

  // ────────────────────────────────────────────────────────────────────────
  // 8) LOCAL PPM METER
  // ────────────────────────────────────────────────────────────────────────
  function setupPPMMeter(stream) {
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
    const source = audioContext.createMediaStreamSource(stream);
    const splitter = audioContext.createChannelSplitter(2);

    analyserL = audioContext.createAnalyser();
    analyserL.fftSize = 256;
    analyserR = audioContext.createAnalyser();
    analyserR.fftSize = 256;

    source.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    drawStereoMeter();
  }

  function drawStereoMeter() {
    if (!analyserL || !analyserR) return;

    const bufferLength = analyserL.frequencyBinCount;
    const dataArrayL = new Uint8Array(bufferLength);
    const dataArrayR = new Uint8Array(bufferLength);
    const ctx = meterCanvas.getContext('2d');
    const width = meterCanvas.width;
    const height = meterCanvas.height;

    function draw() {
      analyserL.getByteFrequencyData(dataArrayL);
      analyserR.getByteFrequencyData(dataArrayR);

      let sumL = 0, sumR = 0;
      for (let i = 0; i < bufferLength; i++) {
        sumL += dataArrayL[i] * dataArrayL[i];
        sumR += dataArrayR[i] * dataArrayR[i];
      }
      const rmsL = Math.sqrt(sumL / bufferLength) / 255;
      const rmsR = Math.sqrt(sumR / bufferLength) / 255;

      ctx.clearRect(0, 0, width, height);

      // Left (green) top half
      const barL = Math.round(rmsL * width);
      ctx.fillStyle = '#4caf50';
      ctx.fillRect(0, 0, barL, height / 2 - 2);

      // Right (blue) bottom half
      const barR = Math.round(rmsR * width);
      ctx.fillStyle = '#2196f3';
      ctx.fillRect(0, height / 2 + 2, barR, height / 2 - 2);

      requestAnimationFrame(draw);
    }
    draw();
  }

  // ────────────────────────────────────────────────────────────────────────
  // 9) CLEANUP ON UNLOAD
  // ────────────────────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    if (pc) pc.close();
    if (ws) ws.close();
    if (audioContext) audioContext.close();
  });

  // Helper: create compressed stream (–14 dBFS compressor)
  function createCompressedStream(rawStream) {
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyserL = null;
      analyserR = null;
    }
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
    const srcNode = audioContext.createMediaStreamSource(rawStream);
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-14, audioContext.currentTime);
    compressor.knee.setValueAtTime(0, audioContext.currentTime);
    compressor.ratio.setValueAtTime(12, audioContext.currentTime);
    compressor.attack.setValueAtTime(0.003, audioContext.currentTime);
    compressor.release.setValueAtTime(0.25, audioContext.currentTime);
    srcNode.connect(compressor);
    const destNode = audioContext.createMediaStreamDestination();
    compressor.connect(destNode);
    return destNode.stream;
  }
});
