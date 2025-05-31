/**
 * studio.js
 *
 * Front-end logic for the studio control interface.
 * - Connects to the signaling server via WebSocket.
 * - Manages a separate RTCPeerConnection per remote contributor.
 * - Displays contributor list, mute/unmute, audio meters, connection status, and codec info.
 * - Handles studio↔remote chat.
 */

(() => {
  // ICE servers configuration
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
  let ws;
  const peers = new Map(); // remoteID -> { pc, audioElement, meterCanvas, analyserL, analyserR, meterContext }
  const contributorListEl = document.getElementById('contributors-list');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  /////////////////////////////////////////////////////
  // Utility: Create WebSocket and set up handlers
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('WebSocket connected (studio).');
      // Send join as studio
      ws.send(JSON.stringify({ type: 'join', role: 'studio', name: 'Studio' }));
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
      console.warn('WebSocket closed. Retrying in 5 seconds...');
      setTimeout(initWebSocket, 5000);
    };

    ws.onerror = err => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  }

  /////////////////////////////////////////////////////
  // Handle incoming signaling messages
  /////////////////////////////////////////////////////
  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'existing-remotes':
        // { type:'existing-remotes', remotes: [ {id, name}, ... ] }
        for (const { id, name } of msg.remotes) {
          addContributorUI(id, name);
          // We expect them to re-offer soon; do nothing until offer arrives
        }
        break;

      case 'new-remote':
        // { type:'new-remote', id, name }
        addContributorUI(msg.id, msg.name);
        break;

      case 'offer':
        // { type:'offer', from: remoteID, sdp }
        handleOffer(msg.from, msg.sdp);
        break;

      case 'candidate':
        // { type:'candidate', from: remoteID|studio, candidate }
        handleCandidate(msg.from, msg.candidate);
        break;

      case 'remote-disconnected':
        // { type:'remote-disconnected', id }
        removeContributor(msg.id);
        break;

      case 'chat':
        // { type:'chat', from, name, message }
        appendChatMessage(msg.name, msg.message, msg.from === 'studio');
        break;

      case 'studio-disconnected':
        // This shouldn’t happen for the studio itself
        break;

      default:
        console.warn('Unknown message type (studio):', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Add a new contributor block in the UI
  /////////////////////////////////////////////////////
  function addContributorUI(remoteID, remoteName) {
    if (peers.has(remoteID)) return; // already exists

    // List item container
    const li = document.createElement('li');
    li.id = `contributor-${remoteID}`;
    li.className = 'contributor-item';

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = remoteName;
    li.appendChild(nameSpan);

    // Status
    const statusSpan = document.createElement('span');
    statusSpan.className = 'status';
    statusSpan.id = `status-${remoteID}`;
    statusSpan.textContent = 'connecting...';
    li.appendChild(statusSpan);

    // Mute/unmute button
    const muteBtn = document.createElement('button');
    muteBtn.textContent = 'Mute';
    muteBtn.className = 'mute-btn';
    muteBtn.disabled = true; // only enabled after connection
    muteBtn.onclick = () => {
      const entry = peers.get(remoteID);
      if (!entry) return;
      entry.audioElement.muted = !entry.audioElement.muted;
      if (entry.audioElement.muted) {
        muteBtn.textContent = 'Unmute';
        muteBtn.classList.add('active');
      } else {
        muteBtn.textContent = 'Mute';
        muteBtn.classList.remove('active');
      }
    };
    li.appendChild(muteBtn);

    // Meter canvas (stereo: draw two bars)
    const meterCanvas = document.createElement('canvas');
    meterCanvas.width = 100;
    meterCanvas.height = 20; // two channels stacked
    meterCanvas.className = 'meter-canvas';
    meterCanvas.id = `meter-${remoteID}`;
    li.appendChild(meterCanvas);

    contributorListEl.appendChild(li);

    // Create hidden audio element to attach remote track
    const audioEl = document.createElement('audio');
    audioEl.id = `audio-${remoteID}`;
    audioEl.autoplay = true;
    audioEl.controls = false;
    audioEl.muted = false;
    document.body.appendChild(audioEl);

    // Prepare placeholders in peers map
    peers.set(remoteID, {
      pc: null,
      audioElement: audioEl,
      meterCanvas,
      meterContext: meterCanvas.getContext('2d'),
      analyserL: null,
      analyserR: null,
      statusSpan,
      muteBtn
    });
  }

  /////////////////////////////////////////////////////
  // Remove a contributor from UI and cleanup
  /////////////////////////////////////////////////////
  function removeContributor(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    // Close RTCPeerConnection
    if (entry.pc) {
      entry.pc.close();
    }
    // Remove audio element
    if (entry.audioElement) {
      entry.audioElement.srcObject = null;
      entry.audioElement.remove();
    }
    // Remove DOM elements
    const li = document.getElementById(`contributor-${remoteID}`);
    if (li) li.remove();

    entry.meterCanvas.remove();
    peers.delete(remoteID);
  }

  /////////////////////////////////////////////////////
  // Handle incoming offer from a remote: create PC + answer
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    // Create RTCPeerConnection for this remoteID
    const pc = new RTCPeerConnection(ICE_CONFIG);
    entry.pc = pc;

    // Update status
    entry.statusSpan.textContent = 'connecting...';

    // Parse codec details from SDP
    const codecInfo = parseOpusInfo(sdp);
    if (codecInfo) {
      const codecSpan = document.createElement('span');
      codecSpan.textContent = ` [codec: ${codecInfo}]`;
      entry.statusSpan.appendChild(codecSpan);
    }

    // When an incoming track arrives
    pc.ontrack = evt => {
      // Expecting one MediaStream with one or two tracks (stereo)
      const [remoteStream] = evt.streams;
      entry.audioElement.srcObject = remoteStream;

      // Set up audio meter
      setupMeter(remoteID, remoteStream);
    };

    // ICE candidates from studio → send to remote
    pc.onicecandidate = evt => {
      if (evt.candidate) {
        ws.send(
          JSON.stringify({
            type: 'candidate',
            from: 'studio',
            target: remoteID,
            candidate: evt.candidate
          })
        );
      }
    };

    // Connection state handling
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      entry.statusSpan.textContent = state;
      if (state === 'connected') {
        entry.muteBtn.disabled = false;
      } else {
        entry.muteBtn.disabled = true;
      }
    };

    // Set Remote SDP (offer)
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    } catch (err) {
      console.error(`Failed to set remote description for ${remoteID}:`, err);
      return;
    }

    // Create answer
    let answer;
    try {
      answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (err) {
      console.error(`Failed to create/set local answer for ${remoteID}:`, err);
      return;
    }

    // Send answer back to remote
    ws.send(
      JSON.stringify({
        type: 'answer',
        from: 'studio',
        target: remoteID,
        sdp: pc.localDescription.sdp
      })
    );
  }

  /////////////////////////////////////////////////////
  // Handle incoming ICE candidate (either from remote or studio)
  /////////////////////////////////////////////////////
  async function handleCandidate(from, candidate) {
    if (from === 'studio') {
      // candidate from studio? (unlikely in this direction)
      return;
    }

    const entry = peers.get(from);
    if (!entry || !entry.pc) {
      console.warn('Received candidate for non-existent PC:', from);
      return;
    }
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(`Error adding ICE candidate for ${from}:`, err);
    }
  }

  /////////////////////////////////////////////////////
  // Parse Opus codec info from an SDP offer
  /////////////////////////////////////////////////////
  function parseOpusInfo(sdp) {
    const lines = sdp.split('\n');
    let opusPayloadType = null;
    const fmtMap = new Map();
    let sampling = null,
      channels = null;

    for (const line of lines) {
      if (line.startsWith('a=rtpmap:') && line.includes('opus/48000')) {
        // e.g. a=rtpmap:111 opus/48000/2
        const parts = line.trim().split(' ');
        const payload = parts[0].split(':')[1];
        const params = parts[1].split('/');
        if (params[0] === 'opus') {
          opusPayloadType = payload;
          sampling = params[1];
          channels = params[2];
          fmtMap.set(payload, `Opus ${sampling}Hz/${channels}ch`);
        }
      }
    }
    if (opusPayloadType && fmtMap.has(opusPayloadType)) {
      return fmtMap.get(opusPayloadType);
    }
    return null;
  }

  /////////////////////////////////////////////////////
  // Set up stereo audio meter for an incoming MediaStream
  /////////////////////////////////////////////////////
  function setupMeter(remoteID, stream) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);

    // Split channels
    const splitter = audioCtx.createChannelSplitter(2);
    src.connect(splitter);

    // Two analyzers (L & R)
    const analyserL = audioCtx.createAnalyser();
    analyserL.fftSize = 256;
    const analyserR = audioCtx.createAnalyser();
    analyserR.fftSize = 256;

    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    entry.analyserL = analyserL;
    entry.analyserR = analyserR;

    // Start drawing
    drawMeter(remoteID);
  }

  /////////////////////////////////////////////////////
  // Continuously draw the audio meter for a contributor
  /////////////////////////////////////////////////////
  function drawMeter(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || !entry.analyserL || !entry.analyserR) return;

    const { analyserL, analyserR, meterCanvas, meterContext } = entry;
    const bufferLength = analyserL.frequencyBinCount;
    const dataArrayL = new Uint8Array(bufferLength);
    const dataArrayR = new Uint8Array(bufferLength);

    function draw() {
      analyserL.getByteFrequencyData(dataArrayL);
      analyserR.getByteFrequencyData(dataArrayR);

      // Compute RMS (approx) for each channel
      let sumL = 0,
        sumR = 0;
      for (let i = 0; i < bufferLength; i++) {
        sumL += dataArrayL[i] * dataArrayL[i];
        sumR += dataArrayR[i] * dataArrayR[i];
      }
      const rmsL = Math.sqrt(sumL / bufferLength) / 255; // normalized 0..1
      const rmsR = Math.sqrt(sumR / bufferLength) / 255;

      // Clear canvas
      meterContext.clearRect(0, 0, meterCanvas.width, meterCanvas.height);

      // Draw left channel (top half)
      meterContext.fillStyle = '#4caf50'; // green
      const widthL = Math.round(rmsL * meterCanvas.width);
      meterContext.fillRect(0, 0, widthL, meterCanvas.height / 2 - 1);

      // Draw right channel (bottom half)
      meterContext.fillStyle = '#2196f3'; // blue
      const widthR = Math.round(rmsR * meterCanvas.width);
      meterContext.fillRect(0, meterCanvas.height / 2 + 1, widthR, meterCanvas.height / 2 - 1);

      requestAnimationFrame(draw);
    }

    draw();
  }

  /////////////////////////////////////////////////////
  // Remove contributor logic (call from signaling)
  /////////////////////////////////////////////////////
  function removeContributorUI(remoteID) {
    removeContributor(remoteID);
  }

  /////////////////////////////////////////////////////
  // Chat logic (studio side)
  /////////////////////////////////////////////////////
  function appendChatMessage(senderName, message, isStudio) {
    const div = document.createElement('div');
    div.className = 'chat-message';
    if (isStudio) {
      div.innerHTML = `<strong>Studio:</strong> ${message}`;
    } else {
      div.innerHTML = `<strong>${senderName}:</strong> ${message}`;
    }
    chatWindowEl.appendChild(div);
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  }

  sendChatBtn.onclick = () => {
    const text = chatInputEl.value.trim();
    if (!text) return;
    // Send to all remotes and also display locally
    const msgObj = {
      type: 'chat',
      from: 'studio',
      name: 'Studio',
      message: text,
      target: 'all'
    };
    ws.send(JSON.stringify(msgObj));
    appendChatMessage('Studio', text, true);
    chatInputEl.value = '';
  };

  /////////////////////////////////////////////////////
  // Initialization
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    initWebSocket();
  });
})();
