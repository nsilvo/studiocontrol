/**
 * public/js/remote.js
 *
 * - Two-step remote flow:
 *    1. Prompt for name (Step 1).
 *    2. Once name is submitted, reveal main UI, show displayName, set up a
 *       stereo mic capture with a –14 dBFS compressor, and start WebSocket/RTC.
 *
 * - Listens for studio “mode-update” messages to switch between:
 *     • speech → mono (1 channel)
 *     • music  → stereo (2 channels)
 *   Automatically re-negotiates the connection when mode changes.
 *
 * - Listens for studio “bitrate-update” messages to adjust encoder bitrate.
 *
 * - All outgoing audio is passed through a DynamicsCompressorNode (threshold −14 dB)
 *   to approximate a −14 LUFS limit.
 *
 * - PPM meter always displays two bars (left + right). If only 1 channel is active,
 *   it displays the same data on both bars (effectively a mono display).
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
  let localStream = null;       // Raw mic MediaStream
  let processedStream = null;   // After compressor
  let audioSender = null;
  let localID = null;
  let displayName = '';
  let currentMode = 'music';    // Default: 'music' → stereo; studio can override to 'speech'
  let isMuted = false;
  let isTone = false;

  // GLITS-tone nodes (always stereo)
  let toneContext = null;
  let leftOsc = null;
  let rightOsc = null;
  let gainLeft = null;
  let gainRight = null;
  let merger = null;
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

  let audioContext = null;
  let analyserL = null;
  let analyserR = null;

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
        alert('Please enter your name before continuing.');
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
    toneBtn.onclick = toggleTone;
    listenStudioBtn.onclick = toggleListenStudio;
    sendChatBtn.onclick = sendChat;
  }

  /////////////////////////////////////////////////////
  // Initialize WebSocket & event listeners
  /////////////////////////////////////////////////////
  function initWebSocket() {
    // Use wss:// or ws:// based on page protocol
    const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(`${wsProtocol}${window.location.host}`);

    ws.onopen = () => {
      console.log('WebSocket connected (remote).');
      statusSpan.textContent = 'connected (WS)';
      // Send join with displayName
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'remote',
          name: displayName,
        })
      );
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (err) {
        console.error('Invalid JSON from server:', err);
        return;
      }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      console.warn('WebSocket closed. Reconnecting in 5 seconds...');
      statusSpan.textContent = 'disconnected (WS)';
      setTimeout(initWebSocket, 5000);
      if (pc) {
        pc.close();
        pc = null;
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  }

  /////////////////////////////////////////////////////
  // Handle incoming signaling messages
  /////////////////////////////////////////////////////
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        // { type:'joined', id }
        localID = msg.id;
        console.log('Assigned localID:', localID);
        statusSpan.textContent = 'waiting for studio';
        break;

      case 'start-call':
        // Studio asks us to start WebRTC
        statusSpan.textContent = 'connecting (WebRTC)…';
        await startWebRTC();
        break;

      case 'answer':
        // { type:'answer', from:'studio', sdp }
        await handleAnswer(msg.sdp);
        break;

      case 'candidate':
        // { type:'candidate', from:'studio', candidate }
        await handleCandidate(msg.candidate);
        break;

      case 'mode-update':
        // { type:'mode-update', mode: 'speech'|'music' }
        console.log('Received mode-update:', msg.mode);
        await applyMode(msg.mode);
        break;

      case 'bitrate-update':
        // { type:'bitrate-update', bitrate:<number> }
        console.log('Received bitrate-update:', msg.bitrate);
        setAudioBitrate(msg.bitrate);
        break;

      case 'mute-update':
        // { type:'mute-update', muted: true|false }
        console.log('Received mute-update:', msg.muted);
        handleMute(msg.muted);
        break;

      case 'kick':
        // { type:'kick' }
        console.warn('Received kick. Closing connection.');
        alert('❌ You have been kicked by the studio.');
        ws.close();
        break;

      case 'chat':
        // { type:'chat', from:'studio', name:'Studio', message }
        appendChatMessage(msg.name || 'Studio', msg.message, false);
        break;

      default:
        // Silently ignore any other message
        break;
    }
  }

  /////////////////////////////////////////////////////
  // Start WebRTC: capture stereo by default, compress, and connect
  /////////////////////////////////////////////////////
  async function startWebRTC() {
    // Step 1: capture mic with requested channel count based on currentMode
    const channelCount = currentMode === 'speech' ? 1 : 2;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: channelCount,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      console.error('getUserMedia error:', err);
      statusSpan.textContent = 'mic error';
      return;
    }

    // Step 2: process through compressor graph
    processedStream = createCompressedStream(localStream);

    // Step 3: create PeerConnection (if not exists already)
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
        statusSpan.textContent = `connected (WebRTC: ${state})`;
        console.log('Connection state:', state);
      };
    } else {
      // If PC exists from a previous call (mode-change), remove old sender
      if (audioSender) {
        pc.removeTrack(audioSender);
        audioSender = null;
      }
    }

    // Step 4: add the compressed track
    audioSender = pc.addTrack(processedStream.getAudioTracks()[0], processedStream);

    // Step 5: set a default bitrate (studio can override)
    setAudioBitrate(64000);

    // Step 6: start the PPM meter for processedStream
    setupLocalMeter(processedStream);

    // Step 7: create offer → send to studio
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error('createOffer error:', err);
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
  // Handle answer from studio
  /////////////////////////////////////////////////////
  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      console.log('Remote description (answer) set');
    } catch (err) {
      console.error('setRemoteDescription error:', err);
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
      console.error('addIceCandidate error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Apply a new mode: 'speech' (mono) or 'music' (stereo)
  // Re-capture, re-compress, replace track, and renegotiate.
  /////////////////////////////////////////////////////
  async function applyMode(newMode) {
    if (newMode !== 'speech' && newMode !== 'music') return;
    if (currentMode === newMode) return;
    currentMode = newMode;
    if (!pc) return; // If WebRTC not started yet, startWebRTC will use updated currentMode

    // 1) Stop existing Track + AudioContext if any
    if (audioSender) {
      pc.removeTrack(audioSender);
      audioSender = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyserL = null;
      analyserR = null;
    }

    // 2) Get new mic capture with updated channelCount
    const channelCount = currentMode === 'speech' ? 1 : 2;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: channelCount,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      console.error('getUserMedia (mode-change) error:', err);
      return;
    }

    // 3) Re-compress
    processedStream = createCompressedStream(localStream);

    // 4) Add new track
    audioSender = pc.addTrack(processedStream.getAudioTracks()[0], processedStream);

    // 5) Reapply bitrate if previously set (studio will usually resend)
    //    Here we leave it to studio to re-send bitrate-update, but we
    //    can keep lastKnownBitrate if tracked. For now, no change.

    // 6) Restart PPM meter
    setupLocalMeter(processedStream);

    // 7) Renegotiate: create new offer and send to studio
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(
        JSON.stringify({
          type: 'offer',
          from: localID,
          sdp: pc.localDescription.sdp,
        })
      );
    } catch (err) {
      console.error('Reoffer error (mode-change):', err);
    }
  }

  /////////////////////////////////////////////////////
  // Create a compressed MediaStream from a raw mic stream
  // Uses a DynamicsCompressorNode with threshold −14 dBFS.
  /////////////////////////////////////////////////////
  function createCompressedStream(rawStream) {
    // If there is an existing audioContext, close it to avoid multiple contexts
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyserL = null;
      analyserR = null;
    }

    // 1) New AudioContext
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });

    // 2) Create MediaStreamSource from raw mic
    const srcNode = audioContext.createMediaStreamSource(rawStream);

    // 3) Create a DynamicsCompressorNode
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-14, audioContext.currentTime); // −14 dBFS threshold
    compressor.knee.setValueAtTime(0, audioContext.currentTime);
    compressor.ratio.setValueAtTime(12, audioContext.currentTime);
    compressor.attack.setValueAtTime(0.003, audioContext.currentTime);
    compressor.release.setValueAtTime(0.25, audioContext.currentTime);

    // 4) Connect source → compressor
    srcNode.connect(compressor);

    // 5) Create a MediaStreamDestination
    const destNode = audioContext.createMediaStreamDestination();
    compressor.connect(destNode);

    // 6) Return the new compressed stream
    return destNode.stream;
  }

  /////////////////////////////////////////////////////
  // Local audio PPM meter (always stereo output)
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
      console.warn('Audio sender not yet ready for bitrate change');
      return;
    }
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings.forEach((enc) => {
      enc.maxBitrate = bitrate;
    });
    try {
      await audioSender.setParameters(params);
      console.log(`Audio bitrate set to ${bitrate} bps`);
      statusSpan.textContent = `bitrate set to ${Math.round(bitrate / 1000)} kbps`;
    } catch (err) {
      console.error('setParameters error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Handle mute/unmute (remote → studio)
  /////////////////////////////////////////////////////
  function handleMute(muted) {
    isMuted = muted;
    if (audioSender) {
      const track = isMuted ? null : processedStream.getAudioTracks()[0];
      audioSender.replaceTrack(track);
    }
    muteBtn.textContent = isMuted ? 'Unmute Myself' : 'Mute Myself';
    statusSpan.textContent = muted ? '🔇 You are muted by studio' : '🔈 You are unmuted';
  }

  function toggleMute() {
    if (!audioSender) return;
    isMuted = !isMuted;
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
    if (!audioSender) return;
    if (!isTone) {
      startGlitsTone();
      isTone = true;
      toneBtn.textContent = 'Stop GLITS Tone';
    } else {
      stopGlitsTone();
      isTone = false;
      toneBtn.textContent = 'Send GLITS Tone';
    }
  }

  /////////////////////////////////////////////////////
  // Start GLITS Tone (always stereo)
  /////////////////////////////////////////////////////
  function startGlitsTone() {
    if (!audioSender) return;

    // 1 kHz sine on each channel at −18 dBFS → gain = 10^(−18/20) ≈ 0.125892541
    const amplitude = 0.125892541;

    // If there was a previous toneContext, close it
    if (toneContext) {
      toneContext.close();
      toneContext = null;
      leftOsc = null;
      rightOsc = null;
      gainLeft = null;
      gainRight = null;
      merger = null;
      glitsInterval = null;
    }

    toneContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });

    // Create oscillators for left & right
    leftOsc = toneContext.createOscillator();
    rightOsc = toneContext.createOscillator();
    leftOsc.type = 'sine';
    rightOsc.type = 'sine';
    leftOsc.frequency.setValueAtTime(1000, toneContext.currentTime);
    rightOsc.frequency.setValueAtTime(1000, toneContext.currentTime);

    // Create gain nodes
    gainLeft = toneContext.createGain();
    gainRight = toneContext.createGain();
    gainLeft.gain.value = amplitude;
    gainRight.gain.value = amplitude;

    // Create merger (2 inputs → stereo)
    merger = toneContext.createChannelMerger(2);

    // Connect: leftOsc → gainLeft → merger input 0
    leftOsc.connect(gainLeft);
    gainLeft.connect(merger, 0, 0);

    // Connect: rightOsc → gainRight → merger input 1
    rightOsc.connect(gainRight);
    gainRight.connect(merger, 0, 1);

    // Start oscillators
    leftOsc.start();
    rightOsc.start();

    // Create destination (MediaStream) for the merged stereo
    const dest = toneContext.createMediaStreamDestination();
    merger.connect(dest);

    // Replace outgoing track with the GLITS stream
    audioSender.replaceTrack(dest.stream.getAudioTracks()[0]);

    // Schedule interruptions every 4 s
    setGlitsSchedule();
    glitsInterval = setInterval(setGlitsSchedule, 4000);

    // Meter the GLITS tone (dest.stream is stereo)
    setupLocalMeter(dest.stream);
  }

  /////////////////////////////////////////////////////
  // Stop GLITS Tone
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
    if (gainLeft) {
      gainLeft.disconnect();
      gainLeft = null;
    }
    if (gainRight) {
      gainRight.disconnect();
      gainRight = null;
    }
    if (merger) {
      merger.disconnect();
      merger = null;
    }

    // Restore microphone track
    if (processedStream) {
      audioSender.replaceTrack(processedStream.getAudioTracks()[0]);
      setupLocalMeter(processedStream);
    }
  }

  /////////////////////////////////////////////////////
  // Schedule a single GLITS cycle (4 s)
  /////////////////////////////////////////////////////
  function setGlitsSchedule() {
    if (!toneContext || !gainLeft || !gainRight) return;
    const base = toneContext.currentTime;

    // LEFT: silent [t → t+0.25], then on [t+0.25 → next cycle]
    gainLeft.gain.setValueAtTime(0, base);
    gainLeft.gain.setValueAtTime(0.125892541, base + 0.25);

    // RIGHT channel pattern:
    //   On [t → t+0.25]
    gainRight.gain.setValueAtTime(0.125892541, base);
    //   Silence [t+0.25 → t+0.50]
    gainRight.gain.setValueAtTime(0, base + 0.25);
    //   On [t+0.50 → t+0.75]
    gainRight.gain.setValueAtTime(0.125892541, base + 0.5);
    //   Silence [t+0.75 → t+1.00]
    gainRight.gain.setValueAtTime(0, base + 0.75);
    //   Then remain on until next cycle
    gainRight.gain.setValueAtTime(0.125892541, base + 1.0);
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
  /////////////////////////////////////////////////////
  function sendChat() {
    const text = chatInputEl.value.trim();
    if (!text) return;
    ws.send(
      JSON.stringify({
        type: 'chat',
        from: localID,
        name: displayName,
        message: text,
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
