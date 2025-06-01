/**
 * public/js/sports.js (No Compression)
 *
 * - Captures raw mic (mono or stereo per mode) directly, merges with GLITS tone when active.
 * - Stereo VU meter for outgoing audio.
 * - Keeps GLITS tone generation, PPM meter, mode/bitrate switching, chat, keepalives, local recording.
 * - Sports features: Reporter name, Team A/B, Score & “Report Goal” with flashing indicator until ack.
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
  let audioContext = null;       // AudioContext for mic + tone graph + VU meter
  let micGain = null;            // Gain for mic path
  let toneGain = null;           // Gain for tone path
  let merger = null;             // ChannelMergerNode (2 inputs → stereo)
  let processedStream = null;    // Merged stream (mic + tone) → RTCPeerConnection
  let audioSender = null;        // RTCRtpSender for outgoing audio
  let localID = null;
  let reporterName = '';
  let teamAName = '';
  let teamBName = '';
  let scoreA = 0;
  let scoreB = 0;
  let goalPending = false;       // true until studio acknowledges

  let currentMode = 'music';     // 'music' (stereo mic) or 'speech' (mono mic)
  let isMuted = false;
  let isTone = false;

  // GLITS‐tone oscillator nodes (always stereo)
  let leftOsc = null;
  let rightOsc = null;
  let glitsInterval = null;

  // Local segment recording
  let localRecorder = null;
  let localChunks = [];
  let isLocalRecording = false;

  // DOM elements
  let reporterNameInput,
    teamAInput,
    teamBInput,
    nameSubmitBtn,
    nameStepDiv,
    mainUiDiv;
  let reporterNameDisplay,
    teamADisplay,
    teamBDisplay,
    scoreBoard,
    goalIndicator;
  let goalBtn,
    localRecordBtn,
    stopLocalRecordBtn,
    localRecordLinks;
  let statusSpan,
    muteBtn,
    toneBtn,
    listenStudioBtn,
    meterCanvas,
    meterContext,
    chatWindowEl,
    chatInputEl,
    sendChatBtn;
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
  // Step 1: Prompt for reporter name & teams
  /////////////////////////////////////////////////////
  function initNameStep() {
    reporterNameInput = document.getElementById('reporterNameInput');
    teamAInput = document.getElementById('teamAInput');
    teamBInput = document.getElementById('teamBInput');
    nameSubmitBtn = document.getElementById('nameSubmitBtn');
    nameStepDiv = document.getElementById('name-step');
    mainUiDiv = document.getElementById('main-ui');

    nameSubmitBtn.onclick = () => {
      const rName = reporterNameInput.value.trim();
      const tA = teamAInput.value.trim();
      const tB = teamBInput.value.trim();
      if (!rName || !tA || !tB) {
        alert('Please enter Reporter Name and both Team names.');
        return;
      }
      reporterName = rName;
      teamAName = tA;
      teamBName = tB;

      // Hide name step, show main UI
      nameStepDiv.classList.add('hidden');
      mainUiDiv.classList.remove('hidden');

      // Initialize UI first (so scoreBoard, reporterNameDisplay, etc. exist)
      initSportsUI();

      // Fill in header displays
      reporterNameDisplay.textContent = reporterName;
      teamADisplay.textContent = teamAName;
      teamBDisplay.textContent = teamBName;
      updateScoreDisplay();

      // Initialize WebSocket
      initWebSocket();
    };
  }

  /////////////////////////////////////////////////////
  // Step 2: Initialize Sports UI & event handlers
  /////////////////////////////////////////////////////
  function initSportsUI() {
    reporterNameDisplay = document.getElementById('reporterNameDisplay');
    teamADisplay = document.getElementById('teamADisplay');
    teamBDisplay = document.getElementById('teamBDisplay');
    scoreBoard = document.getElementById('scoreBoard');
    goalIndicator = document.getElementById('goalIndicator');

    goalBtn = document.getElementById('goalBtn');
    localRecordBtn = document.getElementById('localRecordBtn');
    stopLocalRecordBtn = document.getElementById('stopLocalRecordBtn');
    localRecordLinks = document.getElementById('localRecordLinks');

    goalBtn.onclick = reportGoal;
    localRecordBtn.onclick = startLocalRecording;
    stopLocalRecordBtn.onclick = stopLocalRecording;

    // Regular remote controls
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

    // Disable “Send GLITS Tone” until WebRTC is ready
    toneBtn.disabled = true;
    toneBtn.onclick = toggleTone;
  }

  /////////////////////////////////////////////////////
  // Update the score display (TeamA : TeamB)
  /////////////////////////////////////////////////////
  function updateScoreDisplay() {
    scoreBoard.textContent = `${scoreA} : ${scoreB}`;
  }

  /////////////////////////////////////////////////////
  // Report a goal: increment local score, notify studio, flash indicator
  /////////////////////////////////////////////////////
  function reportGoal() {
    if (goalPending) return; // already waiting for ack
    // Increment Team A’s score for simplicity
    scoreA += 1;
    updateScoreDisplay();

    // Flash GOAL indicator
    goalIndicator.style.display = 'block';
    goalPending = true;

    // Send “goal” message to studio
    ws.send(
      JSON.stringify({
        type: 'goal',
        from: localID,
        reporter: reporterName,
        teamA: teamAName,
        teamB: teamBName,
        scoreA,
        scoreB,
      })
    );
  }

  /////////////////////////////////////////////////////
  // Acknowledge goal cleared by studio
  /////////////////////////////////////////////////////
  function clearGoalIndicator() {
    goalIndicator.style.display = 'none';
    goalPending = false;
  }

  /////////////////////////////////////////////////////
  // Local segment recording
  /////////////////////////////////////////////////////
  async function startLocalRecording() {
    if (isLocalRecording) return;
    if (!audioContext || !processedStream) {
      alert('Audio not initialized yet.');
      return;
    }
    localRecorder = new MediaRecorder(processedStream, { mimeType: 'audio/webm' });
    localChunks = [];
    localRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) localChunks.push(e.data);
    };
    localRecorder.onstop = () => {
      const blob = new Blob(localChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `segment-${Date.now()}.webm`;
      link.textContent = `Download Segment (${new Date().toLocaleTimeString()})`;
      link.style.display = 'block';
      localRecordLinks.appendChild(link);
    };
    localRecorder.start();
    isLocalRecording = true;
    localRecordBtn.disabled = true;
    stopLocalRecordBtn.disabled = false;
  }

  function stopLocalRecording() {
    if (!isLocalRecording || !localRecorder) return;
    localRecorder.stop();
    isLocalRecording = false;
    localRecordBtn.disabled = false;
    stopLocalRecordBtn.disabled = true;
  }

  /////////////////////////////////////////////////////
  // Initialize WebSocket & event listeners
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('[sports] WS connected');
      statusSpan.textContent = 'Connected (WS)';

      // Send join along with reporterName so studio knows who and which page
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'sports-remote',
          name: reporterName,
        })
      );
      // Start keepalives
      startKeepalive();
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (err) {
        console.error('[sports] Invalid JSON from server:', err);
        return;
      }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      console.warn('[sports] WS closed. Reconnecting in 5 seconds...');
      statusSpan.textContent = 'Disconnected (WS)';
      stopKeepalive();
      setTimeout(initWebSocket, 5000);
      if (pc) {
        pc.close();
        pc = null;
      }
      if (isTone) {
        stopGlitsTone();
        isTone = false;
        toneBtn.textContent = 'Send GLITS Tone';
        toneBtn.disabled = true;
      }
    };

    ws.onerror = (err) => {
      console.error('[sports] WS error:', err);
      ws.close();
    };
  }

  /////////////////////////////////////////////////////
  // Handle incoming signaling messages
  /////////////////////////////////////////////////////
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        localID = msg.id;
        console.log('[sports] Joined as ID:', localID);
        statusSpan.textContent = 'Waiting for studio';
        break;

      case 'id-assigned':
        localID = msg.id;
        console.log('[sports] Assigned localID:', localID);
        statusSpan.textContent = 'Waiting for studio';
        break;

      case 'start-call':
        statusSpan.textContent = 'Connecting (WebRTC)...';
        await startWebRTC();
        break;

      case 'answer':
        await handleAnswer(msg.sdp);
        break;

      case 'candidate':
        await handleCandidate(msg.candidate);
        break;

      case 'mode-update':
        console.log('[sports] Received mode-update:', msg.mode);
        await applyMode(msg.mode);
        break;

      case 'bitrate-update':
        console.log('[sports] Received bitrate-update:', msg.bitrate);
        setAudioBitrate(msg.bitrate);
        break;

      case 'chat':
        appendChatMessage(msg.from, msg.text, false);
        break;

      case 'mute-update':
        console.log('[sports] Mute update:', msg.muted);
        applyRemoteMute(msg.muted);
        break;

      case 'goal-ack':
        // Studio has acknowledged our goal
        clearGoalIndicator();
        break;

      default:
        // we ignore keepalive and other unrecognized types
        if (msg.type !== 'keepalive') {
          console.warn('[sports] Unknown signaling message:', msg.type);
        }
    }
  }

  /////////////////////////////////////////////////////
  // Start WebRTC: capture raw mic, merge with tone, connect
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
      console.error('[sports] getUserMedia error:', err);
      statusSpan.textContent = 'Mic error';
      return;
    }

    // Step 2: build a single AudioContext graph: micGain + toneGain → merger → dest
    setupAudioGraph(channelCountMic);

    // Step 3: create PeerConnection if not exists
    if (!pc) {
      pc = new RTCPeerConnection(ICE_CONFIG);

      // Receive studio audio
      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        if (!audioStudioElem.srcObject) {
          audioStudioElem.srcObject = incomingStream;
        }
      };

      // Send ICE candidates to server
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
        console.log('[sports] Connection state:', state);
      };
    } else {
      // If PC exists from a previous call (mode-change), remove old sender
      if (audioSender) {
        pc.removeTrack(audioSender);
        audioSender = null;
      }
    }

    // Step 4: add the merged (raw mic+tone) track
    audioSender = pc.addTrack(processedStream.getAudioTracks()[0], processedStream);

    // Enable tone button now that audioSender is ready
    toneBtn.disabled = false;

    // Step 5: set default bitrate
    setAudioBitrate(64000);

    // Step 6: start the PPM meter for processedStream
    setupLocalMeter(processedStream);

    // Step 7: create offer → send to studio
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error('[sports] createOffer error:', err);
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
  // Build AudioContext graph WITHOUT compression
  // micGain + toneGain → merger → MediaStreamDestination
  /////////////////////////////////////////////////////
  function setupAudioGraph(channelCountMic) {
    // Close any previous AudioContext
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

    // 2) Create Gain nodes: one for mic, one for tone
    micGain = audioContext.createGain();
    micGain.gain.value = 1; // mic on

    toneGain = audioContext.createGain();
    toneGain.gain.value = 0; // tone off initially

    // 3) Connect mic → micGain
    micSource.connect(micGain);

    // 4) Create merger of 2 inputs (stereo)
    merger = audioContext.createChannelMerger(2);
    micGain.connect(merger, 0, 0);
    toneGain.connect(merger, 0, 1);

    // 5) Merger → destination
    const destNode = audioContext.createMediaStreamDestination();
    merger.connect(destNode);

    // 6) processedStream is now raw mic+tone
    processedStream = destNode.stream;
  }

  /////////////////////////////////////////////////////
  // Handle answer from studio
  /////////////////////////////////////////////////////
  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      console.log('[sports] Remote description (answer) set');
    } catch (err) {
      console.error('[sports] setRemoteDescription error:', err);
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
      console.error('[sports] addIceCandidate error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Apply a new mode: 'speech' (mono) or 'music' (stereo)
  // Simply re-capture mic and reconnect micGain → merger
  /////////////////////////////////////////////////////
  async function applyMode(newMode) {
    if (newMode !== 'speech' && newMode !== 'music') return;
    if (currentMode === newMode) return;
    currentMode = newMode;
    if (!pc) return;

    // Stop old mic tracks
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    // Request new mic capture
    const channelCountMic = currentMode === 'speech' ? 1 : 2;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: channelCountMic,
        },
      });
    } catch (err) {
      console.error('[sports] getUserMedia (mode-change) error:', err);
      return;
    }

    // Reconnect new mic to micGain
    const micSource = audioContext.createMediaStreamSource(micStream);
    micGain.disconnect();
    micSource.connect(micGain);

    // If tone not active, ensure micGain=1, toneGain=0
    if (!isTone) {
      micGain.gain.setValueAtTime(1, audioContext.currentTime);
      toneGain.gain.setValueAtTime(0, audioContext.currentTime);
    }

    // Replace outgoing track and renegotiate
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
      console.error('[sports] Reoffer error (mode-change):', err);
    }
  }

  /////////////////////////////////////////////////////
  // Local audio PPM (stereo) meter on processedStream
  /////////////////////////////////////////////////////
  function setupLocalMeter(stream) {
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
      console.warn('[sports] Audio sender not yet ready for bitrate change');
      return;
    }
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings.forEach((enc) => {
      enc.maxBitrate = bitrate;
    });
    try {
      await audioSender.setParameters(params);
      console.log(`[sports] Audio bitrate set to ${bitrate} bps`);
      statusSpan.textContent = `Bitrate: ${Math.round(bitrate / 1000)} kbps`;
    } catch (err) {
      console.error('[sports] setParameters error:', err);
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
  // Apply remote‐imposed mute (studio → remote)
  /////////////////////////////////////////////////////
  function applyRemoteMute(muted) {
    isMuted = muted;
    if (audioSender) {
      const track = isMuted ? null : processedStream.getAudioTracks()[0];
      audioSender.replaceTrack(track);
      console.log('[sports] Applied studio mute:', muted);
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
      console.warn('[sports] Cannot send tone: audioSender not ready');
      return;
    }

    if (!isTone) {
      console.log('[sports] Enabling GLITS tone');
      startGlitsTone();
      isTone = true;
      toneBtn.textContent = 'Stop GLITS Tone';
    } else {
      console.log('[sports] Disabling GLITS tone');
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
      console.warn('[sports] audioContext or toneGain not set; cannot start tone');
      return;
    }

    // 1 kHz sine on each channel at –18 dBFS → gain ≈ 0.125892541
    const amplitude = 0.125892541;

    // If there's already an oscillator, stop it
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

    // LEFT channel pattern: silent [t → t+0.25], then on [t+0.25 → end]
    toneGain.gain.setValueAtTime(0, base);
    toneGain.gain.setValueAtTime(amp, base + 0.25);

    // RIGHT channel pattern approximated on same gain node:
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
        name: reporterName,
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
