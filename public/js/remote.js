/**
 * public/js/remote.js (No Compression)
 *
 * - Two‐step remote flow:
 *    1. Prompt for name.
 *    2. Once name is submitted, reveal main UI, show displayName, set up a
 *       raw stereo/mono mic capture with optional GLITS tone, start WebSocket/RTC.
 *
 * - Listens for studio “mode‐update” messages to switch between:
 *     • speech → mono (1 channel)
 *     • music  → stereo (2 channels)
 *   Automatically re‐negotiates the connection when mode changes.
 *
 * - Listens for studio “bitrate-update” messages to adjust encoder bitrate.
 *
 * - All outgoing audio is raw (no compressor). GLITS tone can be toggled.
 *
 * - PPM meter always displays two bars (left + right). If only 1 channel is active,
 *   it displays the same data on both bars (mono display).
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
  let micStream = null;       // Raw mic MediaStream
  let audioContext = null;    // AudioContext for mic + tone + meter
  let micGain = null;         // Gain node for mic
  let toneGain = null;        // Gain node for GLITS tone
  let merger = null;          // ChannelMergerNode (2 inputs → stereo)
  let processedStream = null; // MediaStream from merger
  let audioSender = null;     // RTCRtpSender for outgoing audio
  let localID = null;
  let displayName = '';
  let currentMode = 'music';  // 'music' (stereo) or 'speech' (mono)
  let isMuted = false;
  let isTone = false;

  // GLITS‐tone nodes
  let leftOsc = null;
  let rightOsc = null;
  let glitsInterval = null;

  // DOM elements
  let nameInput, nameSubmitBtn, nameStepDiv, mainUiDiv, displayNameDiv;
  let statusSpan, muteBtn, toneBtn, listenStudioBtn, meterCanvas, meterContext;
  let chatWindowEl, chatInputEl, sendChatBtn, audioStudioElem;

  // PPM analyser
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
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('[remote] WS opened');
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
        console.error('[remote] Invalid JSON from server:', err);
        return;
      }
      handleSignalingMessage(msg);
    };
    ws.onclose = () => {
      console.warn('[remote] WS closed. Reconnecting in 5 seconds...');
      statusSpan.textContent = 'disconnected (WS)';
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

  /////////////////////////////////////////////////////
  // Handle incoming signaling messages
  /////////////////////////////////////////////////////
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'id-assigned':
        // { type:'id-assigned', id }
        localID = msg.id;
        console.log('[remote] Assigned localID:', localID);
        statusSpan.textContent = 'waiting for studio';
        break;

      case 'start-call':
        // Studio asks us to start WebRTC
        statusSpan.textContent = 'connecting (WebRTC)...';
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
        statusSpan.textContent = 'studio disconnected';
        break;

      case 'chat':
        // { type:'chat', from:'studio', name:'Studio', message }
        appendChatMessage(msg.name, msg.message, false);
        break;

      default:
        console.warn('[remote] Unknown signaling message:', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Start WebRTC: capture raw mic, build merger+tone graph, and connect
  /////////////////////////////////////////////////////
  async function startWebRTC() {
    // Step 1: capture mic with requested channel count based on currentMode
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
      statusSpan.textContent = 'mic error';
      return;
    }

    // Step 2: build a single AudioContext graph: micGain + toneGain → merger → dest
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
        statusSpan.textContent = `connected (WebRTC: ${state})`;
        console.log('[remote] Connection state:', state);
      };
    } else {
      // If PC exists from a previous call (mode-change), remove old sender
      if (audioSender) {
        pc.removeTrack(audioSender);
        audioSender = null;
      }
    }

    // Step 4: add the merged (mic+tone) audio track
    audioSender = pc.addTrack(processedStream.getAudioTracks()[0], processedStream);

    // Step 5: set a default bitrate (studio can override)
    setAudioBitrate(64000);

    // Step 6: start the stereo PPM meter for processedStream
    setupLocalMeter(processedStream);

    // Step 7: create offer → send to studio
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
  // Build AudioContext graph WITHOUT compression:
  // micGain + toneGain → merger → MediaStreamDestination
  /////////////////////////////////////////////////////
  function setupAudioGraph(channelCountMic) {
    // If there's an existing audioContext, close it
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

    // 2) Create mic source
    const srcNode = audioContext.createMediaStreamSource(micStream);

    // 3) Create Gain nodes
    micGain = audioContext.createGain();
    micGain.gain.value = 1; // mic on

    toneGain = audioContext.createGain();
    toneGain.gain.value = 0; // tone off initially

    // 4) Connect mic → micGain
    srcNode.connect(micGain);

    // 5) Create merger (2-input → stereo)
    merger = audioContext.createChannelMerger(2);
    micGain.connect(merger, 0, 0);
    toneGain.connect(merger, 0, 1);

    // 6) Merger → destination
    const destNode = audioContext.createMediaStreamDestination();
    merger.connect(destNode);

    // 7) processedStream from destNode
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
  // Re‐capture, reconnect micGain→merger, and renegotiate.
  /////////////////////////////////////////////////////
  async function applyMode(newMode) {
    if (newMode !== 'speech' && newMode !== 'music') return;
    if (currentMode === newMode) return;
    currentMode = newMode;
    if (!pc) return; // If WebRTC not started yet, startWebRTC will use updated currentMode

    // 1) Stop existing mic tracks
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    // 2) Request new mic capture
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

    // 3) Reconnect new mic to micGain
    const micSource = audioContext.createMediaStreamSource(micStream);
    micGain.disconnect();
    micSource.connect(micGain);

    // If tone not active, ensure micGain=1, toneGain=0
    if (!isTone) {
      micGain.gain.setValueAtTime(1, audioContext.currentTime);
      toneGain.gain.setValueAtTime(0, audioContext.currentTime);
    }

    // 4) Replace outgoing track and renegotiate
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
  // Create a stereo PPM meter on processedStream
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
      statusSpan.textContent = `bitrate set to ${Math.round(bitrate / 1000)} kbps`;
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
  // Start GLITS Tone through the raw merger graph
  /////////////////////////////////////////////////////
  function startGlitsTone() {
    if (!audioContext || !toneGain) {
      console.warn('[remote] audioContext or toneGain not set; cannot start tone');
      return;
    }

    // 1 kHz sine on each channel at –18 dBFS → gain = 0.125892541
    const amplitude = 0.125892541;

    // If there was a previous toneContext, stop it
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

    leftOsc = audioContext.createOscillator();
    rightOsc = audioContext.createOscillator();
    leftOsc.type = 'sine';
    rightOsc.type = 'sine';
    leftOsc.frequency.setValueAtTime(1000, audioContext.currentTime);
    rightOsc.frequency.setValueAtTime(1000, audioContext.currentTime);

    leftOsc.connect(toneGain);
    rightOsc.connect(toneGain);

    toneGain.gain.setValueAtTime(0, audioContext.currentTime);

    leftOsc.start();
    rightOsc.start();

    setGlitsSchedule();
    glitsInterval = setInterval(setGlitsSchedule, 4000);

    // Mute microphone path when tone is active
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

    // RIGHT channel pattern (approximated)
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
