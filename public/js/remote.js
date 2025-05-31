/**
 * public/js/remote.js
 *
 * - Two‐step remote flow:
 *    1. Prompt for name.
 *    2. Once name is submitted, initialize UI, mic, and WebSocket/RTC.
 *
 * - All outgoing audio (mic or GLITS tone) is passed through a
 *   single AudioContext → Gain nodes → DynamicsCompressorNode
 *   → MediaStreamDestination → sent via RTCPeerConnection.
 *
 * - Studio “mode‐update” (speech vs. music) changes channel count
 *   only on the mic capture. Tone is always stereo.
 *
 * - Studio “bitrate‐update” adjusts encoder bitrate.
 *
 * - PPM meter displays two bars (left + right).
 *
 * - WebSocket keepalives every 30s to avoid idle‐timeout drops.
 */

(() => {
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

  let ws = null;
  let pc = null;
  let micStream = null;          // Raw microphone MediaStream
  let audioContext = null;       // Single AudioContext for mic + tone + compressor
  let micGain = null;            // Gain for mic path
  let toneGain = null;           // Gain for tone path
  let compressor = null;         // DynamicsCompressorNode
  let processedStream = null;    // Output from compressor → RTCPeerConnection
  let audioSender = null;        // RTCRtpSender for outgoing audio
  let localID = null;
  let displayName = '';
  let currentMode = 'music';     // 'music' (stereo) or 'speech' (mono)
  let isMuted = false;
  let isTone = false;

  // GLITS‐tone oscillator nodes (always stereo)
  let leftOsc = null;
  let rightOsc = null;
  let glitsInterval = null;

  // DOM elements
  let nameInput;
  let nameSubmitBtn;
  let nameStepDiv;
  let mainUiDiv;
  let displayNameDiv;

  let statusSpan;
  let muteBtn;
  let toneBtn;
  let listenStudioBtn;
  let meterCanvas;
  let meterContext;
  let chatWindowEl;
  let chatInputEl;
  let sendChatBtn;
  let audioStudioElem;

  let analyserL = null;
  let analyserR = null;

  // ────────────────────────────────────────────────────────────────────────
  // KEEPALIVE LOGIC
  let keepaliveIntervalId = null;
  function startKeepalive() {
    if (keepaliveIntervalId) return;
    keepaliveIntervalId = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'keepalive' }));
      }
    }, 30000);
  }
  function stopKeepalive() {
    if (keepaliveIntervalId) {
      clearInterval(keepaliveIntervalId);
      keepaliveIntervalId = null;
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  /////////////////////////////////////////////////////
  // Step 1: Prompt for name
  /////////////////////////////////////////////////////
  function initNameStep() {
    nameInput = document.getElementById('nameInput');
    nameSubmitBtn = document.getElementById('nameSubmitBtn');
    nameStepDiv = document.getElementById('name-step');
    mainUiDiv = document.getElementById('main-ui');
    displayNameDiv = document.getElementById('display-name');

    nameSubmitBtn.onclick = () => {
      const typedName = nameInput.value.trim();
      if (!typedName) {
        alert('Please enter your name.');
        return;
      }
      displayName = typedName;

      // Hide name step, reveal main UI
      nameStepDiv.classList.add('hidden');
      mainUiDiv.classList.remove('hidden');
      displayNameDiv.textContent = `Name: ${displayName}`;

      // Initialize UI and WebSocket
      initMainUI();
      initWebSocket();
    };
  }

  /////////////////////////////////////////////////////
  // Step 2: Initialize main UI & event handlers
  /////////////////////////////////////////////////////
  function initMainUI() {
    statusSpan = document.getElementById('connStatus');
    muteBtn = document.getElementById('muteSelfBtn');
    toneBtn = document.getElementById('toneBtn');
    listenStudioBtn = document.getElementById('listenStudioBtn');
    meterCanvas = document.getElementById('meter-canvas');
    meterContext = meterCanvas.getContext('2d');
    chatWindowEl = document.getElementById('chatWindow');
    chatInputEl = document.getElementById('chatInput');
    sendChatBtn = document.getElementById('sendChatBtn');
    audioStudioElem = document.getElementById('audio-studio');

    muteBtn.onclick = toggleMute;
    listenStudioBtn.onclick = toggleListenStudio;
    sendChatBtn.onclick = sendChat;

    // Disable tone button until audioSender is ready
    toneBtn.disabled = true;
    toneBtn.onclick = toggleTone;
  }

  /////////////////////////////////////////////////////
  // Initialize WebSocket & event listeners
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('[remote] WS connected');
      statusSpan.textContent = 'Connected (WS)';
      // Send join with displayName
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'remote',
          name: displayName,
        })
      );
      // Start sending keepalives every 30 seconds
      startKeepalive();
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (err) {
        console.error('[remote] Invalid JSON from server:', err);
        return;
      }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      console.warn('[remote] WS closed. Reconnecting in 5 seconds...');
      statusSpan.textContent = 'Disconnected (WS)';
      // Stop keepalives
      stopKeepalive();
      setTimeout(initWebSocket, 5000);
      if (pc) {
        pc.close();
        pc = null;
      }
      // Reset tone state
      if (isTone) {
        stopGlitsTone();
        isTone = false;
        toneBtn.textContent = 'Send GLITS Tone';
        toneBtn.disabled = true;
      }
    };

    ws.onerror = (err) => {
      console.error('[remote] WS error:', err);
      ws.close();
    };
  }

  /////////////////////////////////////////////////////
  // Handle incoming signaling messages
  /////////////////////////////////////////////////////
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        // Server confirmed our join and gave us an ID.
        // { type: "joined", id: "<uuid>" }
        localID = msg.id;
        console.log('[remote] Joined as ID:', localID);
        statusSpan.textContent = 'Waiting for studio';
        break;

      case 'id-assigned':
        // { type: 'id-assigned', id }
        localID = msg.id;
        console.log('[remote] Assigned localID:', localID);
        statusSpan.textContent = 'Waiting for studio';
        break;

      case 'start-call':
        // { type: 'start-call' }
        statusSpan.textContent = 'Connecting (WebRTC)...';
        await startWebRTC();
        break;

      case 'answer':
        // { type: 'answer', sdp }
        await handleAnswer(msg.sdp);
        break;

      case 'candidate':
        // { type: 'candidate', candidate }
        await handleCandidate(msg.candidate);
        break;

      case 'mode-update':
        // { type:'mode-update', mode:'speech'|'music' }
        console.log('[remote] Received mode-update:', msg.mode);
        await applyMode(msg.mode);
        break;

      case 'bitrate-update':
        // { type:'bitrate-update', bitrate:<number> }
        console.log('[remote] Received bitrate-update:', msg.bitrate);
        setAudioBitrate(msg.bitrate);
        break;

      case 'studio-disconnected':
        console.warn('[remote] Studio disconnected.');
        statusSpan.textContent = 'Studio disconnected';
        break;

      case 'chat':
        // { type:'chat', from:'Studio', text }
        appendChatMessage(msg.from, msg.text, false);
        break;

      case 'mute-update':
        // { type:'mute-update', muted:true/false }
        console.log('[remote] Mute update:', msg.muted);
        applyRemoteMute(msg.muted);
        break;

      default:
        console.warn('[remote] Unknown signaling message:', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Start WebRTC: capture mic, set up compressor+tone, and connect
  /////////////////////////////////////////////////////
  async function startWebRTC() {
    // Step 1: capture mic with requested channel count
    const channelCountMic = currentMode === 'speech' ? 1 : 2;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: channelCountMic,
        },
      });
    } catch (err) {
      console.error('[remote] getUserMedia error:', err);
      statusSpan.textContent = 'Mic error';
      return;
    }

    // Step 2: build a single AudioContext graph: micGain + toneGain → compressor → dest
    setupAudioGraph(channelCountMic);

    // Step 3: create PeerConnection if not exists
    if (!pc) {
      pc = new RTCPeerConnection(ICE_CONFIG);

      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        if (!audioStudioElem.srcObject) {
          audioStudioElem.srcObject = incomingStream;
        }
      };

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          ws.send(
            JSON.stringify({
              type: 'candidate',
              from: localID,
              target: 'studio',
              candidate: evt.candidate,
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        statusSpan.textContent = `Connected (WebRTC: ${state})`;
        console.log('[remote] Connection state:', state);
      };
    } else {
      // If PC existed (mode-change), remove old sender
      if (audioSender) {
        pc.removeTrack(audioSender);
        audioSender = null;
      }
    }

    // Step 4: add compressor output track
    audioSender = pc.addTrack(processedStream.getAudioTracks()[0], processedStream);

    // Enable tone button now that audioSender is ready
    toneBtn.disabled = false;

    // Step 5: set default bitrate (studio can override)
    setAudioBitrate(64000);

    // Step 6: start the PPM meter for processedStream
    setupLocalMeter(processedStream);

    // Step 7: create offer & send to studio
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error('[remote] createOffer error:', err);
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'offer',
        from: localID,
        sdp: pc.localDescription.sdp,
      })
    );
  }

  /////////////////////////////////////////////////////
  // Build AudioContext graph: mic → micGain → compressor → dest
  //                               tone → toneGain ↗
  /////////////////////////////////////////////////////
  function setupAudioGraph(channelCountMic) {
    // If there’s an existing context, shut it down first
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyserL = null;
      analyserR = null;
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });

    // 1) Mic source
    const micSource = audioContext.createMediaStreamSource(micStream);

    // 2) Create two Gain nodes: one for mic, one for tone
    micGain = audioContext.createGain();
    micGain.gain.value = 1; // initially mic on

    toneGain = audioContext.createGain();
    toneGain.gain.value = 0; // tone off initially

    // 3) Connect mic → micGain
    micSource.connect(micGain);

    // 4) Create compressor
    compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-14, audioContext.currentTime);
    compressor.knee.setValueAtTime(0, audioContext.currentTime);
    compressor.ratio.setValueAtTime(12, audioContext.currentTime);
    compressor.attack.setValueAtTime(0.003, audioContext.currentTime);
    compressor.release.setValueAtTime(0.25, audioContext.currentTime);

    // 5) Create merger (if mic is stereo or mono, handle accordingly)
    //    For simplicity, use ChannelMerger of 2 inputs:
    const merger = audioContext.createChannelMerger(2);
    micGain.connect(merger, 0, 0);
    toneGain.connect(merger, 0, 1);

    // 6) Connect merger → compressor
    merger.connect(compressor);

    // 7) Create a MediaStreamDestination
    const destNode = audioContext.createMediaStreamDestination();
    compressor.connect(destNode);

    // 8) Set processedStream to include that single track
    processedStream = destNode.stream;
  }

  /////////////////////////////////////////////////////
  // Handle answer from studio
  /////////////////////////////////////////////////////
  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      console.log('[remote] Remote description (answer) set');
    } catch (err) {
      console.error('[remote] setRemoteDescription error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Handle ICE candidate from studio
  /////////////////////////////////////////////////////
  async function handleCandidate(candidate) {
    if (!pc || !pc.remoteDescription) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[remote] addIceCandidate error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Apply a new mode: 'speech' (mono) or 'music' (stereo)
  // Renegotiate channelCount for mic; tone path remains stereo.
  /////////////////////////////////////////////////////
  async function applyMode(newMode) {
    if (newMode !== 'speech' && newMode !== 'music') return;
    if (currentMode === newMode) return;
    currentMode = newMode;
    if (!pc) return; // PC not started yet; startWebRTC will use updated currentMode

    // 1) Stop existing mic stream
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    // 2) Request new mic capture with updated channelCount
    const channelCountMic = currentMode === 'speech' ? 1 : 2;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: channelCountMic,
        },
      });
    } catch (err) {
      console.error('[remote] getUserMedia (mode-change) error:', err);
      return;
    }

    // 3) Rebuild audio graph: connect new micSource → micGain → merger → compressor
    const micSource = audioContext.createMediaStreamSource(micStream);
    micGain.disconnect();
    micSource.connect(micGain);

    // 4) If currently sending tone, leave toneGain alone; otherwise ensure micGain=1, toneGain=0
    if (!isTone) {
      micGain.gain.value = 1;
      toneGain.gain.value = 0;
    }

    // 5) Renegotiate: replace the track on the same audioSender and send a new offer
    const newTrack = processedStream.getAudioTracks()[0];
    if (audioSender) {
      audioSender.replaceTrack(newTrack);
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(
        JSON.stringify({
          type: 'offer',
          from: localID,
          sdp: pc.localDescription.sdp,
        })
      );
    } catch (err) {
      console.error('[remote] Reoffer error (mode-change):', err);
    }
  }

  /////////////////////////////////////////////////////
  // Local audio PPM meter (always stereo output from processedStream)
  /////////////////////////////////////////////////////
  function setupLocalMeter(stream) {
    // Create a NEW AudioContext solely for metering
    const meterContextAudio = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });
    const source = meterContextAudio.createMediaStreamSource(stream);
    const splitter = meterContextAudio.createChannelSplitter(2);

    analyserL = meterContextAudio.createAnalyser();
    analyserL.fftSize = 256;
    analyserR = meterContextAudio.createAnalyser();
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

      const width = meterCanvas.width;
      const height = meterCanvas.height;
      meterContext.clearRect(0, 0, width, height);

      // Left channel (green) on top half
      const barWidthL = Math.round(rmsL * width);
      meterContext.fillStyle = '#4caf50';
      meterContext.fillRect(0, 0, barWidthL, height / 2 - 2);

      // Right channel (blue) on bottom half
      const barWidthR = Math.round(rmsR * width);
      meterContext.fillStyle = '#2196f3';
      meterContext.fillRect(0, height / 2 + 2, barWidthR, height / 2 - 2);

      requestAnimationFrame(draw);
    }
    draw();
  }

  /////////////////////////////////////////////////////
  // Set outgoing audio bitrate on RTCRtpSender
  /////////////////////////////////////////////////////
  async function setAudioBitrate(bitrate) {
    if (!audioSender) {
      console.warn('[remote] Audio sender not yet ready for bitrate change');
      return;
    }
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings.forEach((enc) => {
      enc.maxBitrate = bitrate;
    });
    try {
      await audioSender.setParameters(params);
      console.log(`[remote] Audio bitrate set to ${bitrate} bps`);
      statusSpan.textContent = `Bitrate: ${Math.round(bitrate / 1000)} kbps`;
    } catch (err) {
      console.error('[remote] setParameters error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Toggle mute/unmute (remote → studio)
  /////////////////////////////////////////////////////
  function toggleMute() {
    if (!audioSender) return;
    isMuted = !isMuted;
    // Mute means replacing track with null
    const track = isMuted ? null : processedStream.getAudioTracks()[0];
    audioSender.replaceTrack(track);

    ws.send(
      JSON.stringify({
        type: 'mute-update',
        from: localID,
        target: 'studio',
        muted: isMuted,
      })
    );

    muteBtn.textContent = isMuted ? 'Unmute Myself' : 'Mute Myself';
  }

  /////////////////////////////////////////////////////
  // Apply remote‐imposed mute (studio → remote)
  /////////////////////////////////////////////////////
  function applyRemoteMute(muted) {
    isMuted = muted;
    if (audioSender) {
      const track = isMuted ? null : processedStream.getAudioTracks()[0];
      audioSender.replaceTrack(track);
      console.log('[remote] Applied studio mute:', muted);
    }
  }

  /////////////////////////////////////////////////////
  // Toggle listen to studio audio
  /////////////////////////////////////////////////////
  function toggleListenStudio() {
    if (!audioStudioElem.srcObject) {
      alert('You are not yet connected to studio audio.');
      return;
    }
    audioStudioElem.muted = !audioStudioElem.muted;
    listenStudioBtn.textContent = audioStudioElem.muted
      ? 'Listen to Studio'
      : 'Mute Studio Audio';
  }

  /////////////////////////////////////////////////////
  // Toggle GLITS Tone (always stereo)
  /////////////////////////////////////////////////////
  function toggleTone() {
    if (!audioSender) {
      console.warn('[remote] Cannot send tone: audioSender not ready');
      return;
    }

    if (!isTone) {
      console.log('[remote] Enabling GLITS tone');
      startGlitsTone();
      isTone = true;
      toneBtn.textContent = 'Stop GLITS Tone';
    } else {
      console.log('[remote] Disabling GLITS tone');
      stopGlitsTone();
      isTone = false;
      toneBtn.textContent = 'Send GLITS Tone';
    }
  }

  /////////////////////////////////////////////////////
  // Start GLITS Tone through the same compressor graph
  /////////////////////////////////////////////////////
  function startGlitsTone() {
    if (!audioContext || !toneGain) {
      console.warn('[remote] audioContext or toneGain not set; cannot start tone');
      return;
    }

    // 1 kHz sine on each channel at –18 dBFS → gain = 10^(–18/20) ≈ 0.125892541
    const amplitude = 0.125892541;

    // If there's already an oscillator running, stop it first
    if (leftOsc) {
      leftOsc.stop();
      leftOsc.disconnect();
      leftOsc = null;
    }
    if (rightOsc) {
      rightOsc.stop();
      rightOsc.disconnect();
      rightOsc = null;
    }
    if (glitsInterval) {
      clearInterval(glitsInterval);
      glitsInterval = null;
    }

    // Create oscillators for left & right channels
    leftOsc = audioContext.createOscillator();
    rightOsc = audioContext.createOscillator();
    leftOsc.type = 'sine';
    rightOsc.type = 'sine';
    leftOsc.frequency.setValueAtTime(1000, audioContext.currentTime);
    rightOsc.frequency.setValueAtTime(1000, audioContext.currentTime);

    // Connect oscillators to toneGain
    leftOsc.connect(toneGain);
    rightOsc.connect(toneGain);

    // Initialize toneGain to silent; we'll schedule amplitude changes
    toneGain.gain.setValueAtTime(0, audioContext.currentTime);

    // Start oscillators
    leftOsc.start();
    rightOsc.start();

    // Schedule the GLITS pattern every 4s
    setGlitsSchedule();
    glitsInterval = setInterval(setGlitsSchedule, 4000);

    // Mute the mic path
    micGain.gain.setValueAtTime(0, audioContext.currentTime);
  }

  /////////////////////////////////////////////////////
  // Stop GLITS Tone and restore microphone
  /////////////////////////////////////////////////////
  function stopGlitsTone() {
    if (glitsInterval) {
      clearInterval(glitsInterval);
      glitsInterval = null;
    }
    if (leftOsc) {
      leftOsc.stop();
      leftOsc.disconnect();
      leftOsc = null;
    }
    if (rightOsc) {
      rightOsc.stop();
      rightOsc.disconnect();
      rightOsc = null;
    }

    // Restore mic path
    micGain.gain.setValueAtTime(1, audioContext.currentTime);
    toneGain.gain.setValueAtTime(0, audioContext.currentTime);
  }

  /////////////////////////////////////////////////////
  // Schedule a single GLITS cycle (4 s)
  /////////////////////////////////////////////////////
  function setGlitsSchedule() {
    if (!audioContext || !toneGain) return;
    const base = audioContext.currentTime;
    const amp = 0.125892541;

    // LEFT: silent [t → t+0.25], then on [t+0.25 → end]
    toneGain.gain.setValueAtTime(0, base);
    toneGain.gain.setValueAtTime(amp, base + 0.25);

    // RIGHT channel pattern on toneGain directly (since both oscillators feed toneGain)
    // We simulate turning the right channel off by setting gain to zero at specific times,
    // then back on. But since toneGain is shared, we approximate by setting amplitude modulations:
    //  On [t → t+0.25], toneGain = amp  (both channels audible; left and right are same freq)
    //  At [t+0.25], mute toneGain for 0.25s → effectively both channels silent (approx)
    //  At [t+0.50], toneGain = amp → both channels audible for 0.25s
    //  At [t+0.75], toneGain = 0 → silent for 0.25s
    //  At [t+1.0], toneGain = amp → remain on until next cycle
    toneGain.gain.setValueAtTime(amp, base);                 // t → t+0.25
    toneGain.gain.setValueAtTime(0, base + 0.25);            // t+0.25 → t+0.50
    toneGain.gain.setValueAtTime(amp, base + 0.5);           // t+0.50 → t+0.75
    toneGain.gain.setValueAtTime(0, base + 0.75);            // t+0.75 → t+1.00
    toneGain.gain.setValueAtTime(amp, base + 1.0);           // t+1.00 → cycle end
  }

  /////////////////////////////////////////////////////
  // Chat: append message
  /////////////////////////////////////////////////////
  function appendChatMessage(senderName, message, isLocal) {
    const div = document.createElement('div');
    div.className = 'chat-message';
    if (isLocal) {
      div.innerHTML = `<strong>You:</strong> ${message}`;
    } else {
      div.innerHTML = `<strong>${senderName}:</strong> ${message}`;
    }
    chatWindowEl.appendChild(div);
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  }

  /////////////////////////////////////////////////////
  // Send chat
  //////////////////////////////////////////////////###
  function sendChat() {
    const text = chatInputEl.value.trim();
    if (!text) return;
    ws.send(
      JSON.stringify({
        type: 'chat',
        from: localID,
        name: displayName,
        text: text,
        target: 'studio',
      })
    );
    appendChatMessage('You', text, true);
    chatInputEl.value = '';
  }

  /////////////////////////////////////////////////////
  // DOCUMENT READY
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    initNameStep();
  });
})();
