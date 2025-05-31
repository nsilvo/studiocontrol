/**
 * remote.js (v5.1)
 *
 * Two‐step remote flow:
 *  1. Prompt for name (Step 1).
 *  2. Once name is entered, reveal main UI, show displayName, and start WebSocket/RTC.
 *
 * GLITS tone implementation:
 *  - 1 kHz sine at –18 dBFS (gain ≈ 0.1259) on both channels continuously.
 *  - Every 4 s (cycle):
 *      • Left channel silent for 250 ms (4.00–4.25 s).
 *      • 250 ms later (at 4.25 s), Right channel silent 250 ms (4.25–4.50), then on 250 ms (4.50–4.75), then silent 250 ms (4.75–5.00), then back on until next 4 s.
 */

(() => {
  // ICE servers configuration (TURN/STUN)
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
  let localStream = null;
  let audioSender = null;
  let localID = null;
  let displayName = ''; // Will be set from name input
  let isMuted = false;
  let isTone = false;

  // GLITS‐tone nodes:
  let toneContext = null;
  let leftOsc = null;
  let rightOsc = null;
  let gainLeft = null;
  let gainRight = null;
  let merger = null;
  let glitsInterval = null; // setInterval reference

  // DOM elements (after Step 1)
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
  // Step 1: Bind name‐submission logic
  /////////////////////////////////////////////////////
  function initNameStep() {
    nameInput = document.getElementById('nameInput');
    nameSubmitBtn = document.getElementById('nameSubmitBtn');
    nameStepDiv = document.getElementById('name-step');
    mainUiDiv = document.getElementById('main-ui');
    displayNameDiv = document.getElementById('display-name');

    nameSubmitBtn.onclick = () => {
      const typed = nameInput.value.trim();
      if (typed === '') {
        alert('Please enter a name before continuing.');
        return;
      }
      displayName = typed;
      // Hide name step, reveal main UI
      nameStepDiv.classList.add('hidden');
      mainUiDiv.classList.remove('hidden');
      displayNameDiv.textContent = `Name: ${displayName}`;
      // Now initialize the rest of the UI and start WS/RTC
      initMainUI();
      initWebSocket();
    };
  }

  /////////////////////////////////////////////////////
  // Initialize main UI elements & event listeners
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
      console.log('WebSocket connected (remote).');
      statusSpan.textContent = 'connected (WS)';
      // Send join with the chosen displayName
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
      case 'id-assigned':
        // { type:'id-assigned', id }
        localID = msg.id;
        console.log('Assigned localID:', localID);
        statusSpan.textContent = 'waiting for studio';
        break;

      case 'start-call':
        // Studio has requested us to start WebRTC
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

      case 'studio-disconnected':
        console.warn('Studio disconnected.');
        statusSpan.textContent = 'studio disconnected';
        break;

      case 'mute-update':
        // { type:'mute-update', from:'studio', muted:true|false }
        handleMuteUpdate(msg.muted);
        break;

      case 'bitrate-update':
        // { type:'bitrate-update', bitrate:<number> }
        console.log('Received bitrate-update:', msg.bitrate);
        setAudioBitrate(msg.bitrate);
        break;

      case 'chat':
        // { type:'chat', from:'studio', name:'Studio', message }
        appendChatMessage(msg.name, msg.message, false);
        break;

      default:
        console.warn('Unknown signaling message (remote):', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Start WebRTC: getUserMedia, createOffer, send to studio
  /////////////////////////////////////////////////////
  async function startWebRTC() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 2,
        },
      });
    } catch (err) {
      console.error('getUserMedia error:', err);
      statusSpan.textContent = 'mic error';
      return;
    }

    pc = new RTCPeerConnection(ICE_CONFIG);

    // Add mic track (remote → studio)
    const track = localStream.getAudioTracks()[0];
    audioSender = pc.addTrack(track, localStream);

    // Set initial bitrate to 64 kbps by default
    setAudioBitrate(64000);

    setupLocalMeter(localStream);

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
  // Handle mute-update from studio
  /////////////////////////////////////////////////////
  function handleMuteUpdate(muted) {
    if (muted) {
      audioSender.replaceTrack(null);
      statusSpan.textContent = 'muted by studio';
    } else {
      const micTrack = localStream.getAudioTracks()[0];
      audioSender.replaceTrack(micTrack);
      statusSpan.textContent = 'unmuted by studio';
    }
  }

  /////////////////////////////////////////////////////
  // Local audio PPM meter
  /////////////////////////////////////////////////////
  function setupLocalMeter(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
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

    drawLocalMeter();
  }

  function drawLocalMeter() {
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

      meterContext.clearRect(0, 0, meterCanvas.width, meterCanvas.height);

      // Draw left channel (green)
      meterContext.fillStyle = '#4caf50';
      const widthL = Math.round(rmsL * meterCanvas.width);
      meterContext.fillRect(0, 0, widthL, meterCanvas.height / 2 - 1);

      // Draw right channel (blue)
      meterContext.fillStyle = '#2196f3';
      const widthR = Math.round(rmsR * meterCanvas.width);
      meterContext.fillRect(
        0,
        meterCanvas.height / 2 + 1,
        widthR,
        meterCanvas.height / 2 - 1
      );

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
  // Toggle mute/unmute (remote → studio)
  /////////////////////////////////////////////////////
  function toggleMute() {
    if (!audioSender) return;
    isMuted = !isMuted;
    const track = isMuted ? null : localStream.getAudioTracks()[0];
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
  // Toggle GLITS Tone
  /////////////////////////////////////////////////////
  function toggleTone() {
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
  // Start GLITS Tone
  /////////////////////////////////////////////////////
  function startGlitsTone() {
    if (!audioSender) return;

    // 1 kHz sine on each channel at –18 dBFS → gain = 10^(–18/20) ≈ 0.125892541
    const amplitude = 0.125892541;

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

    // Connect leftOsc → gainLeft → merger input 0
    leftOsc.connect(gainLeft);
    gainLeft.connect(merger, 0, 0);

    // Connect rightOsc → gainRight → merger input 1
    rightOsc.connect(gainRight);
    gainRight.connect(merger, 0, 1);

    // Start oscillators
    leftOsc.start();
    rightOsc.start();

    // Connect merged stereo to a MediaStreamDestination
    const dest = toneContext.createMediaStreamDestination();
    merger.connect(dest);

    // Replace outgoing track with the new stereo GLITS stream
    const toneTrack = dest.stream.getAudioTracks()[0];
    audioSender.replaceTrack(toneTrack);

    // Schedule the first GLITS‐cycle 4 s from now
    setGlitsSchedule();
    glitsInterval = setInterval(setGlitsSchedule, 4000);

    // Also draw local meter from GLITS source
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

    // Restore mic track
    if (localStream) {
      const micTrack = localStream.getAudioTracks()[0];
      audioSender.replaceTrack(micTrack);
      setupLocalMeter(localStream);
    }
  }

  /////////////////////////////////////////////////////
  // Schedule one GLITS Tone cycle
  /////////////////////////////////////////////////////
  function setGlitsSchedule() {
    if (!toneContext || !gainLeft || !gainRight) return;

    // Use audioContext.currentTime as the base
    const base = toneContext.currentTime;

    // 1) Left channel: silent from base → base+0.25, then restore until next cycle
    gainLeft.gain.setValueAtTime(0, base);
    gainLeft.gain.setValueAtTime(0.125892541, base + 0.25);

    // 2) Right channel:  
    //    - Tone on from base → base+0.25  
    gainRight.gain.setValueAtTime(0.125892541, base);
    //    - Silence from base+0.25 → base+0.50  
    gainRight.gain.setValueAtTime(0, base + 0.25);
    //    - Tone from base+0.50 → base+0.75  
    gainRight.gain.setValueAtTime(0.125892541, base + 0.50);
    //    - Silence from base+0.75 → base+1.00  
    gainRight.gain.setValueAtTime(0, base + 0.75);
    //    - Tone from base+1.00 → next cycle  
    gainRight.gain.setValueAtTime(0.125892541, base + 1.00);
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
  // DOCUMENT READY (initial)
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    initNameStep();
  });
})();
