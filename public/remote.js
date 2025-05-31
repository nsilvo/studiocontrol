/**
 * remote.js
 *
 * Front-end logic for a remote contributor (v3).
 * - Handles “kicked” message from server, alerting the user and closing.
 * - Everything else is same as before (waiting → start-call → WebRTC).
 */

(() => {
  // ICE servers configuration
  const ICE_CONFIG = {
    iceServers: [
      {
        urls: ['turn:turn.nkpa.co.uk:3478'],
        username: 'webrtcuser',
        credential: 'uS2h$2JW!hL3!E9yb1N1',
      },
    ],
  };

  // Globals
  let ws = null;
  let pc = null;
  let localStream = null;
  let audioSender = null;
  let localID = null;
  let displayName = '';
  let isMuted = false;
  let isTone = false;
  let toneOscillator = null;
  let toneContext = null;
  let toneDestination = null;

  const setupSection = document.getElementById('setup-section');
  const nameInput = document.getElementById('nameInput');
  const connectBtn = document.getElementById('connectBtn');
  const remoteUI = document.getElementById('remote-ui');
  const muteSelfBtn = document.getElementById('muteSelfBtn');
  const toneBtn = document.getElementById('toneBtn');
  const connStatusSpan = document.getElementById('connStatus');
  const meterCanvas = document.getElementById('meter-canvas');
  const meterContext = meterCanvas.getContext('2d');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  let audioContext = null;
  let analyserL = null;
  let analyserR = null;

  /////////////////////////////////////////////////////
  // Initialize WebSocket
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);

    ws.onopen = () => {
      console.log('WebSocket connected (remote).');
      ws.send(JSON.stringify({ type: 'join', role: 'remote', name: displayName }));
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
      connStatusSpan.textContent = 'disconnected';
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
        connStatusSpan.textContent = 'waiting';
        break;

      case 'start-call':
        // Studio approved connection → start WebRTC
        connStatusSpan.textContent = 'connecting...';
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
        connStatusSpan.textContent = 'studio disconnected';
        break;

      case 'kicked':
        // { type: 'kicked', reason: '...' }
        alert(`You have been disconnected by the studio:\n\n${msg.reason}`);
        ws.close();
        connStatusSpan.textContent = 'kicked';
        break;

      case 'chat':
        // { type:'chat', from, name, message }
        appendChatMessage(msg.name, msg.message, msg.from === localID);
        break;

      default:
        console.warn('Unknown signaling message (remote):', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Start WebRTC handshake (getUserMedia → createOffer → send to studio)
  /////////////////////////////////////////////////////
  async function startWebRTC() {
    // Acquire microphone (48 kHz stereo)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 2,
        },
      });
    } catch (err) {
      console.error('Failed to getUserMedia:', err);
      connStatusSpan.textContent = 'mic error';
      return;
    }

    // Create RTCPeerConnection
    pc = new RTCPeerConnection(ICE_CONFIG);

    // Add audio track & keep sender reference
    const track = localStream.getAudioTracks()[0];
    audioSender = pc.addTrack(track, localStream);

    // Set up local audio meter (mic)
    setupLocalMeter(localStream);

    // ICE candidates → send to studio
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

    // Connection state updates
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      connStatusSpan.textContent = state;
      console.log('Connection state:', state);
    };

    // Create offer, set local description
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error('Failed to create/set offer:', err);
      return;
    }

    // Send offer to studio
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
      console.error('Error setting remote description (answer):', err);
    }
  }

  /////////////////////////////////////////////////////
  // Handle ICE candidate from studio
  /////////////////////////////////////////////////////
  async function handleCandidate(candidate) {
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Set up stereo meter for local audio (mic or tone)
  /////////////////////////////////////////////////////
  function setupLocalMeter(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const source = audioContext.createMediaStreamSource(stream);

    const splitter = audioContext.createChannelSplitter(2);
    source.connect(splitter);

    analyserL = audioContext.createAnalyser();
    analyserL.fftSize = 256;
    analyserR = audioContext.createAnalyser();
    analyserR.fftSize = 256;

    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    drawLocalMeter();
  }

  /////////////////////////////////////////////////////
  // Draw local audio meter (green = left, blue = right)
  /////////////////////////////////////////////////////
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

      meterContext.fillStyle = '#4caf50';
      const widthL = Math.round(rmsL * meterCanvas.width);
      meterContext.fillRect(0, 0, widthL, meterCanvas.height / 2 - 1);

      meterContext.fillStyle = '#2196f3';
      const widthR = Math.round(rmsR * meterCanvas.width);
      meterContext.fillRect(0, meterCanvas.height / 2 + 1, widthR, meterCanvas.height / 2 - 1);

      requestAnimationFrame(draw);
    }

    draw();
  }

  /////////////////////////////////////////////////////
  // Toggle mute/unmute
  /////////////////////////////////////////////////////
  function toggleMute() {
    if (!audioSender) return;
    isMuted = !isMuted;
    const track = isMuted ? null : localStream.getAudioTracks()[0];
    audioSender.replaceTrack(track);
    muteSelfBtn.textContent = isMuted ? 'Unmute' : 'Mute';
    if (isMuted) {
      analyserL.disconnect();
      analyserR.disconnect();
    } else {
      setupLocalMeter(localStream);
    }
  }

  /////////////////////////////////////////////////////
  // Toggle sending a 1 kHz test tone
  /////////////////////////////////////////////////////
  function toggleTone() {
    if (!audioSender) return;

    if (!isTone) {
      toneContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      toneOscillator = toneContext.createOscillator();
      toneOscillator.type = 'sine';
      toneOscillator.frequency.setValueAtTime(1000, toneContext.currentTime);

      toneDestination = toneContext.createMediaStreamDestination();
      toneOscillator.connect(toneDestination);
      toneOscillator.start();

      const toneTrack = toneDestination.stream.getAudioTracks()[0];
      audioSender.replaceTrack(toneTrack);

      setupLocalMeter(toneDestination.stream);

      isTone = true;
      toneBtn.textContent = 'Stop Tone';
      console.log('Switched to tone');
    } else {
      toneOscillator.stop();
      toneOscillator.disconnect();
      toneDestination.disconnect();

      const micTrack = localStream.getAudioTracks()[0];
      audioSender.replaceTrack(micTrack);

      setupLocalMeter(localStream);

      isTone = false;
      toneBtn.textContent = 'Send Tone';
      console.log('Switched to microphone');
    }
  }

  /////////////////////////////////////////////////////
  // Append chat message to chat window
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

  sendChatBtn.onclick = () => {
    const text = chatInputEl.value.trim();
    if (!text) return;
    const msgObj = {
      type: 'chat',
      from: localID,
      name: displayName,
      message: text,
      target: 'studio',
    };
    ws.send(JSON.stringify(msgObj));
    appendChatMessage('You', text, true);
    chatInputEl.value = '';
  };

  /////////////////////////////////////////////////////
  // Event Listeners
  /////////////////////////////////////////////////////
  connectBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) {
      alert('Please enter your name.');
      return;
    }
    displayName = name;
    setupSection.style.display = 'none';
    remoteUI.style.display = 'block';
    connStatusSpan.textContent = 'connecting...';
    initWebSocket();
  };

  muteSelfBtn.onclick = toggleMute;
  toneBtn.onclick = toggleTone;

  /////////////////////////////////////////////////////
  // End of IIFE
  /////////////////////////////////////////////////////
})();
