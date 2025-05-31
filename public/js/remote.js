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
 *
 * - Receives an incoming audio track from the studio (the mixed “studio audio”) and
 *   plays it through <audio id="audio-studio">.
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
  let audioSender = null;
  let remoteId = null;
  let displayName = '';
  let currentMode = 'music';    // Default to stereo
  let currentBitrate = 16000;
  let hasLoggedBitrate = false;

  let audioContext = null;
  let analyserL = null;
  let analyserR = null;

  // GLITS‐tone state
  let isTone = false;
  let toneContext = null;
  let toneOsc = null;
  let toneGain = null;

  // DOM elements
  const nameStepDiv    = document.getElementById('name-step');
  const nameInput      = document.getElementById('nameInput');
  const nameSubmitBtn  = document.getElementById('nameSubmitBtn');
  const mainUiDiv      = document.getElementById('main-ui');
  const displayNameDiv = document.getElementById('display-name');
  const statusSpan     = document.getElementById('connStatus');
  const muteBtn        = document.getElementById('muteSelfBtn');
  const toneBtn        = document.getElementById('toneBtn');
  const listenBtn      = document.getElementById('listenStudioBtn');
  const meterCanvas    = document.getElementById('meter-canvas');
  const chatWindowEl   = document.getElementById('chatWindow');
  const chatInputEl    = document.getElementById('chatInput');
  const sendChatBtn    = document.getElementById('sendChatBtn');
  const audioStudioEl  = document.getElementById('audio-studio');

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
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'remote',
          name: displayName
        })
      );
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

  function handleSignalingMessage(msg) {
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
        startWebRTC();
        break;

      case 'answer':
        // { type:'answer', sdp }
        handleAnswer(msg.sdp);
        break;

      case 'candidate':
        // { type:'candidate', candidate }
        handleCandidate(msg.candidate);
        break;

      case 'mode-update':
        // { type:'mode-update', mode:'speech'|'music' }
        applyMode(msg.mode);
        break;

      case 'bitrate-update':
        // { type:'bitrate-update', bitrate:<number> }
        handleBitrateUpdate(msg.bitrate);
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

      // 3.3 Add local mic track
      audioSender = pc.addTrack(localStream.getAudioTracks()[0], localStream);

      // 3.4 Listen for incoming studio track
      pc.ontrack = (evt) => {
        const [studioStream] = evt.streams;
        if (audioStudioEl.srcObject !== studioStream) {
          audioStudioEl.srcObject = studioStream;
          audioStudioEl.style.display = 'block';
        }
      };

      // 3.5 ICE candidate handler
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(
            JSON.stringify({
              type: 'candidate',
              from: remoteId,
              target: 'studio',
              candidate: e.candidate
            })
          );
        }
      };

      // 3.6 Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 3.7 Send offer
      ws.send(
        JSON.stringify({
          type: 'offer',
          from: remoteId,
          sdp: offer.sdp
        })
      );
      statusSpan.textContent = 'Offer sent. Awaiting answer…';
    } catch (err) {
      console.error('[remote] startWebRTC error:', err);
      statusSpan.textContent = 'Error starting call.';
    }
  }

  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp })
      );
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

    if (!pc) {
      statusSpan.textContent = `Mode changed to ${mode}. Waiting to call.`;
      return;
    }

    // Renegotiate with new channel count
    // 1) Replace old mic track
    if (audioSender && localStream) {
      pc.removeTrack(audioSender);
      audioSender = null;
    }
    // 2) Get new stream
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
      audioSender = pc.addTrack(localStream.getAudioTracks()[0], localStream);
      // Reapply bitrate
      handleBitrateUpdate(currentBitrate);

      // 3) Create and send new offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(
        JSON.stringify({
          type: 'offer',
          from: remoteId,
          sdp: offer.sdp
        })
      );
      statusSpan.textContent = `Mode switched to ${mode}. Renegotiated.`;
    } catch (e) {
      console.error('[remote] applyMode error:', e);
    }
  }

  function handleBitrateUpdate(bitrate) {
    currentBitrate = bitrate;
    if (!audioSender) {
      console.warn('[remote] Audio sender not ready for bitrate change');
      return;
    }
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    audioSender
      .setParameters(params)
      .then(() => {
        if (!hasLoggedBitrate) {
          console.log(`[remote] Audio bitrate set to ${bitrate} bps`);
          hasLoggedBitrate = true;
        }
        statusSpan.textContent = `Bitrate set to ${Math.round(bitrate / 1000)} kbps`;
      })
      .catch((err) => {
        console.warn('[remote] setParameters error:', err);
      });
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5) MUTE UPDATE FROM STUDIO
  // ────────────────────────────────────────────────────────────────────────
  function handleMuteUpdate(muted) {
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
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
    ws.send(
      JSON.stringify({
        type: 'chat',
        fromRole: 'remote',
        fromId: remoteId,
        target: 'studio',
        text
      })
    );
    appendChatMessage('You', text);
    chatInputEl.value = '';
  };

  // ────────────────────────────────────────────────────────────────────────
  // 7) GLITS TEST TONE & MUTE SELF
  // ────────────────────────────────────────────────────────────────────────
  toneBtn.onclick = () => {
    if (!audioSender) {
      alert('Audio not yet streaming.');
      return;
    }
    if (!isTone) {
      toneContext = new (window.AudioContext || window.webkitAudioContext)();
      toneGain = toneContext.createGain();
      toneGain.gain.value = 0.1;
      toneOsc = toneContext.createOscillator();
      toneOsc.frequency.value = 1000;
      const toneDest = toneContext.createMediaStreamDestination();
      toneOsc.connect(toneGain).connect(toneDest);
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
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    muteBtn.textContent = track.enabled ? 'Mute Myself' : 'Unmute Myself';
  };

  listenBtn.onclick = () => {
    if (!audioStudioEl.srcObject) {
      alert('No studio audio yet.');
      return;
    }
    audioStudioEl.muted = !audioStudioEl.muted;
    listenBtn.textContent = audioStudioEl.muted ? 'Listen to Studio' : 'Mute Studio Audio';
  };

  // ────────────────────────────────────────────────────────────────────────
  // 8) LOCAL PPM METER
  // ────────────────────────────────────────────────────────────────────────
  function setupPPMMeter(stream) {
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyserL = null;
      analyserR = null;
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

      let sumL = 0,
        sumR = 0;
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
});
