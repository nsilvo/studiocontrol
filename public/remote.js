/**
 * remote.js (v4)
 *
 * - WebRTC “remote contributor” logic:
 *   • Connects to signaling server as role="remote"
 *   • Exchanges SDP offer/answer and ICE candidates
 *   • Sends microphone audio (Opus 48kHz stereo)
 *   • Can mute/unmute self, switch to GLITS tone, listen to studio return audio
 *   • Displays local audio PPM meter
 *   • Receives bitrate-update from studio to adjust encoding bitrate
 *   • Auto‐reconnect on WS close
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
  let displayName = 'Remote';
  let isMuted = false;
  let isTone = false;
  let toneOscillator = null;
  let toneContext = null;
  let toneDestination = null;
  let toneTimer = null;

  // UI elements
  const statusSpan = document.getElementById('connStatus');
  const muteBtn = document.getElementById('muteSelfBtn');
  const toneBtn = document.getElementById('toneBtn');
  const listenStudioBtn = document.getElementById('listenStudioBtn');
  const meterCanvas = document.getElementById('meter-canvas');
  const meterContext = meterCanvas.getContext('2d');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  // Hidden audio element for incoming studio audio
  const audioStudioElem = document.getElementById('audio-studio');

  let audioContext = null;
  let analyserL = null;
  let analyserR = null;

  /////////////////////////////////////////////////////
  // Initialize WebSocket & event listeners
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('WebSocket connected (remote).');
      statusSpan.textContent = 'connected (WS)';
      // Send join
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

    // Set initial bitrate to 64kbps by default
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
  // Local audio meter
  /////////////////////////////////////////////////////
  function setupLocalMeter(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
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
      meterContext.fillRect(0, meterCanvas.height / 2 + 1, widthR, meterCanvas.height / 2 - 1);

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
      statusSpan.textContent = `bitrate set to ${Math.round(bitrate/1000)} kbps`;
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
  // Toggle sending a GLITS tone
  /////////////////////////////////////////////////////
  function toggleTone() {
    if (!audioSender) return;

    if (!isTone) {
      toneContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      toneDestination = toneContext.createMediaStreamDestination();

      toneOscillator = toneContext.createOscillator();
      toneOscillator.type = 'sine';
      toneOscillator.frequency.setValueAtTime(400, toneContext.currentTime);
      toneOscillator.connect(toneDestination);
      toneOscillator.start();

      const toneTrack = toneDestination.stream.getAudioTracks()[0];
      audioSender.replaceTrack(toneTrack);

      let currentFreq = 400;
      toneTimer = setInterval(() => {
        currentFreq = currentFreq === 400 ? 1000 : 400;
        toneOscillator.frequency.setValueAtTime(currentFreq, toneContext.currentTime);
      }, 1000);

      setupLocalMeter(toneDestination.stream);

      isTone = true;
      toneBtn.textContent = 'Stop GLITS Tone';
    } else {
      clearInterval(toneTimer);
      toneOscillator.stop();
      toneOscillator.disconnect();
      toneDestination.disconnect();

      const micTrack = localStream.getAudioTracks()[0];
      audioSender.replaceTrack(micTrack);
      setupLocalMeter(localStream);

      isTone = false;
      toneBtn.textContent = 'Send GLITS Tone';
    }
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
  // EVENT LISTENERS
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    initWebSocket();
  });
  muteBtn.onclick = toggleMute;
  toneBtn.onclick = toggleTone;
  listenStudioBtn.onclick = toggleListenStudio;
  sendChatBtn.onclick = sendChat;
})();
