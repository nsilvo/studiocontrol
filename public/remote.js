/**
 * remote.js
 *
 * Front-end logic for a remote contributor.
 * - Connects to signaling server via WebSocket.
 * - Captures microphone (48 kHz stereo) and establishes WebRTC peer to the studio.
 * - Allows toggling mute/self and sending a 1 kHz test tone.
 * - Displays own audio meter (stereo).
 * - Handles chat ⇆ studio.
 * - Auto-reconnects on WebSocket loss.
 */

(() => {
  // ICE servers configuration (same as studio)
  const ICE_CONFIG = {
    iceServers: [
      {
        urls: ['turn:turn.nkpa.co.uk:3478'],
        username: 'webrtcuser',
        credential: 'uS2h$2JW!hL3!E9yb1N1'
      }
    ]
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
      // Send join
      ws.send(JSON.stringify({ type: 'join', role: 'remote', name: displayName }));
    };

    ws.onmessage = evt => {
      try {
        const msg = JSON.parse(evt.data);
        handleSignalingMessage(msg);
      } catch (err) {
        console.error('Invalid JSON from server:', err);
      }
    };

    ws.onclose = () => {
      console.warn('WebSocket closed. Reconnecting in 5 seconds...');
      connStatusSpan.textContent = 'disconnected';
      setTimeout(initWebSocket, 5000);
      // Clean up existing peer so we can reinit later
      if (pc) {
        pc.close();
        pc = null;
      }
    };

    ws.onerror = err => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  }

  /////////////////////////////////////////////////////
  // Handle signaling messages from server
  /////////////////////////////////////////////////////
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'id-assigned':
        // { type:'id-assigned', id }
        localID = msg.id;
        console.log('Assigned localID:', localID);
        // Now that we have an ID, set up WebRTC
        await startWebRTC();
        break;

      case 'answer':
        // { type:'answer', from:'studio', sdp }
        await handleAnswer(msg.sdp);
        break;

      case 'candidate':
        // { type:'candidate', from:'studio'|'somebody', candidate }
        await handleCandidate(msg.candidate);
        break;

      case 'remote-disconnected':
      case 'studio-disconnected':
        // If studio disconnected, we can display status and try to reinit if needed
        console.warn('Studio disconnected. Will retry connection on next WebSocket reopen.');
        connStatusSpan.textContent = 'studio disconnected';
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
  // Start WebRTC: get microphone, create peer, send offer
  /////////////////////////////////////////////////////
  async function startWebRTC() {
    connStatusSpan.textContent = 'initializing...';

    // 1. Acquire microphone (48 kHz stereo if possible)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 2
        }
      });
    } catch (err) {
      console.error('Failed to getUserMedia:', err);
      connStatusSpan.textContent = 'mic error';
      return;
    }

    // 2. Create RTCPeerConnection
    pc = new RTCPeerConnection(ICE_CONFIG);

    // Add audio tracks to PC; keep reference to sender for replaceTrack
    const track = localStream.getAudioTracks()[0];
    audioSender = pc.addTrack(track, localStream);

    // 3. Set up local audio meter
    setupLocalMeter(localStream);

    // 4. PC event handlers
    pc.onicecandidate = evt => {
      if (evt.candidate) {
        ws.send(
          JSON.stringify({
            type: 'candidate',
            from: localID,
            target: 'studio',
            candidate: evt.candidate
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      connStatusSpan.textContent = state;
      console.log('Connection state:', state);
    };

    // 5. Create offer & setLocalDescription
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error('Failed to create/send offer:', err);
      return;
    }

    // 6. Send offer to studio
    ws.send(
      JSON.stringify({
        type: 'offer',
        from: localID,
        sdp: pc.localDescription.sdp
      })
    );
  }

  /////////////////////////////////////////////////////
  // Handle incoming answer from studio
  /////////////////////////////////////////////////////
  async function handleAnswer(sdp) {
    if (!pc) {
      console.error('No PC when receiving answer');
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      console.log('Remote description (answer) set');
    } catch (err) {
      console.error('Error setting remote description (answer):', err);
    }
  }

  /////////////////////////////////////////////////////
  // Handle incoming ICE candidate from studio
  /////////////////////////////////////////////////////
  async function handleCandidate(candidate) {
    if (!pc) {
      console.error('No PC when receiving candidate');
      return;
    }
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

    // Split channels
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
  // Continuously draw local audio meter
  /////////////////////////////////////////////////////
  function drawLocalMeter() {
    if (!analyserL || !analyserR) return;

    const bufferLength = analyserL.frequencyBinCount;
    const dataArrayL = new Uint8Array(bufferLength);
    const dataArrayR = new Uint8Array(bufferLength);

    function draw() {
      analyserL.getByteFrequencyData(dataArrayL);
      analyserR.getByteFrequencyData(dataArrayR);

      // Compute approximate RMS
      let sumL = 0,
        sumR = 0;
      for (let i = 0; i < bufferLength; i++) {
        sumL += dataArrayL[i] * dataArrayL[i];
        sumR += dataArrayR[i] * dataArrayR[i];
      }
      const rmsL = Math.sqrt(sumL / bufferLength) / 255;
      const rmsR = Math.sqrt(sumR / bufferLength) / 255;

      // Draw on canvas
      meterContext.clearRect(0, 0, meterCanvas.width, meterCanvas.height);

      // Left (green)
      meterContext.fillStyle = '#4caf50';
      const widthL = Math.round(rmsL * meterCanvas.width);
      meterContext.fillRect(0, 0, widthL, meterCanvas.height / 2 - 1);

      // Right (blue)
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
      // Reconnect meter
      setupLocalMeter(localStream);
    }
  }

  /////////////////////////////////////////////////////
  // Toggle sending 1 kHz test tone
  /////////////////////////////////////////////////////
  function toggleTone() {
    if (!audioSender) return;

    if (!isTone) {
      // Create new AudioContext & oscillator
      toneContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      toneOscillator = toneContext.createOscillator();
      toneOscillator.type = 'sine';
      toneOscillator.frequency.setValueAtTime(1000, toneContext.currentTime);

      toneDestination = toneContext.createMediaStreamDestination();
      toneOscillator.connect(toneDestination);
      toneOscillator.start();

      // Replace track with tone track
      const toneTrack = toneDestination.stream.getAudioTracks()[0];
      audioSender.replaceTrack(toneTrack);

      // Re‐setup meter on tone stream
      setupLocalMeter(toneDestination.stream);

      isTone = true;
      toneBtn.textContent = 'Stop Tone';
      console.log('Switched to tone');
    } else {
      // Revert to microphone track
      toneOscillator.stop();
      toneOscillator.disconnect();
      toneDestination.disconnect();

      const micTrack = localStream.getAudioTracks()[0];
      audioSender.replaceTrack(micTrack);

      // Re‐setup meter on mic stream
      setupLocalMeter(localStream);

      isTone = false;
      toneBtn.textContent = 'Send Tone';
      console.log('Switched to microphone');
    }
  }

  /////////////////////////////////////////////////////
  // Chat logic (remote)
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
    // Send to studio
    const msgObj = {
      type: 'chat',
      from: localID,
      name: displayName,
      message: text,
      target: 'studio'
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
