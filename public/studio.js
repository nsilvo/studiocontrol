/**
 * studio.js
 *
 * Front-end logic for the studio control interface (v7).
 * - Ensures remote → studio audio is attached properly.
 * - Maintains two-way audio (studio → remote) and mutual mute as before.
 * - ICE candidate queuing logic remains (silently ignoring unknown peers).
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

  let ws;
  // peers: remoteID → {
  //   state,
  //   liWaiting,
  //   liConnected,
  //   pc,
  //   pendingCandidates,          // queue ICE before PC created
  //   audioElementRemoteToStudio,
  //   audioElementStudioToRemote,
  //   meterCanvas,
  //   analyserL,
  //   analyserR,
  //   meterContext,
  //   statusSpan,
  //   muteBtn,
  //   kickBtn,
  //   remoteMuted,
  //   localMuted
  // }
  const peers = new Map();

  const waitingListEl = document.getElementById('waiting-list');
  const contributorListEl = document.getElementById('contributors-list');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  // Studio's microphone stream (one MediaStream for all peers)
  let studioAudioStream = null;
  let studioAudioTrack = null;

  /////////////////////////////////////////////////////
  // Initialize WebSocket
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('WebSocket connected (studio).');
      ws.send(JSON.stringify({ type: 'join', role: 'studio', name: 'Studio' }));
    };

    ws.onmessage = (evt) => {
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
      case 'existing-remotes':
        for (const { id, name, state } of msg.remotes) {
          addRemoteToUI(id, name, state);
        }
        break;

      case 'new-remote':
        addRemoteToUI(msg.id, msg.name, msg.state);
        break;

      case 'remote-state-change':
        updateRemoteState(msg.id, msg.state);
        break;

      case 'offer':
        await handleOffer(msg.from, msg.sdp);
        break;

      case 'candidate':
        handleCandidate(msg.from, msg.candidate);
        break;

      case 'remote-disconnected':
        removeRemote(msg.id);
        break;

      case 'chat':
        appendChatMessage(msg.name, msg.message, msg.from === 'studio');
        break;

      case 'mute-update':
        handleMuteUpdate(msg.from, msg.muted);
        break;

      case 'kicked':
        alert(`You have been disconnected by the studio:\n\n${msg.reason}`);
        ws.close();
        break;

      case 'error':
        console.error('Error from server:', msg.message);
        break;

      default:
        console.warn('Unknown message type (studio):', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Add a remote to the UI (in waiting or connected)
  /////////////////////////////////////////////////////
  function addRemoteToUI(remoteID, remoteName, state) {
    if (peers.has(remoteID)) return;

    const entry = { state, pendingCandidates: [] };

    // Create waiting-list <li>
    const liWait = document.createElement('li');
    liWait.id = `waiting-${remoteID}`;
    liWait.className = 'contributor-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = remoteName;
    liWait.appendChild(nameSpan);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'status';
    statusSpan.id = `status-${remoteID}`;
    statusSpan.textContent = state === 'waiting' ? 'waiting...' : state;
    liWait.appendChild(statusSpan);
    entry.statusSpan = statusSpan;

    entry.remoteMuted = false;
    entry.localMuted = false;

    if (state === 'waiting') {
      // "Connect" button
      const connectBtn = document.createElement('button');
      connectBtn.textContent = 'Connect';
      connectBtn.onclick = () => {
        ws.send(
          JSON.stringify({
            type: 'connect-remote',
            from: 'studio',
            target: remoteID,
          })
        );
        connectBtn.disabled = true;
        statusSpan.textContent = 'connecting...';
      };
      liWait.appendChild(connectBtn);
      entry.connectBtn = connectBtn;

      waitingListEl.appendChild(liWait);
      entry.liWaiting = liWait;
    } else if (state === 'connected') {
      // (unlikely to get "connected" without going through "waiting")
      addConnectedUI(remoteID, remoteName);
      entry.liWaiting = null;
      entry.liConnected = document.getElementById(`connected-${remoteID}`);
    }

    // Initialize other fields
    entry.pc = null;
    entry.audioElementRemoteToStudio = null;
    entry.audioElementStudioToRemote = null;
    entry.meterCanvas = null;
    entry.analyserL = null;
    entry.analyserR = null;
    entry.meterContext = null;
    entry.muteBtn = null;
    entry.kickBtn = null;

    peers.set(remoteID, entry);
  }

  /////////////////////////////////////////////////////
  // Update a remote’s state
  /////////////////////////////////////////////////////
  function updateRemoteState(remoteID, newState) {
    const entry = peers.get(remoteID);
    if (!entry) return;
    entry.state = newState;

    if (newState === 'connecting') {
      entry.statusSpan.textContent = 'connecting...';
    } else if (newState === 'offered') {
      entry.statusSpan.textContent = 'offered';
    } else if (newState === 'connected') {
      // Move from waiting → connected UI
      if (entry.liWaiting) {
        entry.liWaiting.remove();
        entry.liWaiting = null;
      }
      addConnectedUI(remoteID);
    }
  }

  /////////////////////////////////////////////////////
  // Create Connected Contributors UI (with Mute & Kick)
  /////////////////////////////////////////////////////
  function addConnectedUI(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    const remoteName = entry.liWaiting
      ? entry.liWaiting.querySelector('.name').textContent
      : 'Unknown';

    const liConn = document.createElement('li');
    liConn.id = `connected-${remoteID}`;
    liConn.className = 'contributor-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = remoteName;
    liConn.appendChild(nameSpan);

    const statusSpan = document.createElement('span');
    statusSpan.className = 'status';
    statusSpan.id = `status-connected-${remoteID}`;
    statusSpan.textContent = 'connected';
    liConn.appendChild(statusSpan);
    entry.statusSpan = statusSpan;

    // Mute/Unmute Remote button
    const muteBtn = document.createElement('button');
    muteBtn.textContent = 'Mute Remote';
    muteBtn.className = 'mute-btn';
    muteBtn.disabled = true;
    muteBtn.onclick = () => {
      entry.localMuted = !entry.localMuted;
      entry.audioElementRemoteToStudio.muted = entry.localMuted;
      ws.send(
        JSON.stringify({
          type: 'mute-update',
          from: 'studio',
          target: remoteID,
          muted: entry.localMuted,
        })
      );
      muteBtn.textContent = entry.localMuted ? 'Unmute Remote' : 'Mute Remote';
    };
    liConn.appendChild(muteBtn);
    entry.muteBtn = muteBtn;

    // Kick button
    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Kick';
    kickBtn.className = 'kick-btn';
    kickBtn.style.background = '#dc3545';
    kickBtn.style.marginLeft = '10px';
    kickBtn.onclick = () => {
      if (confirm(`Are you sure you want to kick ${remoteName}?`)) {
        ws.send(
          JSON.stringify({
            type: 'kick-remote',
            from: 'studio',
            target: remoteID,
          })
        );
      }
    };
    liConn.appendChild(kickBtn);
    entry.kickBtn = kickBtn;

    // Audio meter canvas
    const meterCanvas = document.createElement('canvas');
    meterCanvas.width = 100;
    meterCanvas.height = 20;
    meterCanvas.className = 'meter-canvas';
    meterCanvas.id = `meter-${remoteID}`;
    liConn.appendChild(meterCanvas);
    entry.meterCanvas = meterCanvas;
    entry.meterContext = meterCanvas.getContext('2d');

    contributorListEl.appendChild(liConn);
    entry.liConnected = liConn;

    // Hidden <audio> element for remote → studio audio
    const audioRemote = document.createElement('audio');
    audioRemote.id = `audio-remote-${remoteID}`;
    audioRemote.autoplay = true;
    audioRemote.controls = false;
    audioRemote.muted = false;
    document.body.appendChild(audioRemote);
    entry.audioElementRemoteToStudio = audioRemote;

    // Hidden <audio> element for studio → remote audio
    const audioStudio = document.createElement('audio');
    audioStudio.id = `audio-studio-${remoteID}`;
    audioStudio.autoplay = true;
    audioStudio.controls = false;
    audioStudio.muted = false;
    document.body.appendChild(audioStudio);
    entry.audioElementStudioToRemote = audioStudio;

    entry.analyserL = null;
    entry.analyserR = null;

    // Enable the Mute button now
    entry.muteBtn.disabled = false;
  }

  /////////////////////////////////////////////////////
  // Remove a remote from UI and close PC
  /////////////////////////////////////////////////////
  function removeRemote(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    if (entry.pc) {
      entry.pc.close();
    }
    if (entry.audioElementRemoteToStudio) {
      entry.audioElementRemoteToStudio.srcObject = null;
      entry.audioElementRemoteToStudio.remove();
    }
    if (entry.audioElementStudioToRemote) {
      entry.audioElementStudioToRemote.srcObject = null;
      entry.audioElementStudioToRemote.remove();
    }
    if (entry.liWaiting) {
      entry.liWaiting.remove();
    }
    if (entry.liConnected) {
      entry.liConnected.remove();
    }
    if (entry.meterCanvas) {
      entry.meterCanvas.remove();
    }
    peers.delete(remoteID);
  }

  /////////////////////////////////////////////////////
  // Handle incoming offer from remote
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    // Ensure studio microphone is available
    if (!studioAudioStream) {
      try {
        studioAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        studioAudioTrack = studioAudioStream.getAudioTracks()[0];
      } catch (err) {
        console.error('Studio getUserMedia error:', err);
        return;
      }
    }

    // Create RTCPeerConnection if needed
    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      // Add studio → remote track
      if (studioAudioTrack) {
        pc.addTrack(studioAudioTrack, studioAudioStream);
      }

      // Parse Opus info from offer
      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      // Single ontrack handler for remote→studio and studio→remote
      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        // If remote→studio audio not yet attached, do so
        if (!entry.audioElementRemoteToStudio.srcObject) {
          entry.audioElementRemoteToStudio.srcObject = incomingStream;
          setupMeter(remoteID, incomingStream);
        } else if (
          // Otherwise, it must be the studio→remote track echoed (unlikely but kept for completeness)
          !entry.audioElementStudioToRemote.srcObject &&
          evt.track.kind === 'audio'
        ) {
          entry.audioElementStudioToRemote.srcObject = incomingStream;
        }
      };

      // Handle ICE candidates from remote
      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          ws.send(
            JSON.stringify({
              type: 'candidate',
              from: 'studio',
              target: remoteID,
              candidate: evt.candidate,
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        entry.statusSpan.textContent = state;
      };

      // Drain any queued ICE candidates
      entry.pendingCandidates.forEach((c) => {
        pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) => {
          console.error('Error adding queued ICE candidate:', e);
        });
      });
      entry.pendingCandidates = [];
    }

    // Set remote (offer) description
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    } catch (err) {
      console.error(`Failed to set remote description for ${remoteID}:`, err);
      return;
    }

    // Create and send answer
    let answer;
    try {
      answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
    } catch (err) {
      console.error(`Failed to create/set local answer for ${remoteID}:`, err);
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'answer',
        from: 'studio',
        target: remoteID,
        sdp: entry.pc.localDescription.sdp,
      })
    );
  }

  /////////////////////////////////////////////////////
  // Handle incoming ICE candidate
  /////////////////////////////////////////////////////
  function handleCandidate(from, candidate) {
    const entry = peers.get(from);
    if (!entry) {
      // Silently ignore if no peer exists at all
      return;
    }
    if (!entry.pc) {
      // Queue candidate for later if PC not created yet
      entry.pendingCandidates.push(candidate);
      return;
    }
    entry.pc
      .addIceCandidate(new RTCIceCandidate(candidate))
      .catch((err) => console.error(`Error adding ICE candidate for ${from}:`, err));
  }

  /////////////////////////////////////////////////////
  // Handle incoming mute-update
  /////////////////////////////////////////////////////
  function handleMuteUpdate(from, muted) {
    if (peers.has(from)) {
      const entry = peers.get(from);
      entry.remoteMuted = muted;
      if (muted) {
        entry.muteBtn.textContent = 'Remote Muted';
        entry.muteBtn.disabled = true;
      } else {
        entry.muteBtn.textContent = entry.localMuted ? 'Unmute Remote' : 'Mute Remote';
        entry.muteBtn.disabled = false;
      }
    }
  }

  /////////////////////////////////////////////////////
  // Parse Opus codec info from SDP
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
  // Set up stereo audio meter for remote → studio
  /////////////////////////////////////////////////////
  function setupMeter(remoteID, stream) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);

    const splitter = audioCtx.createChannelSplitter(2);
    src.connect(splitter);

    const analyserL = audioCtx.createAnalyser();
    analyserL.fftSize = 256;
    const analyserR = audioCtx.createAnalyser();
    analyserR.fftSize = 256;

    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    entry.analyserL = analyserL;
    entry.analyserR = analyserR;
    entry.meterContext = entry.meterCanvas.getContext('2d');

    drawMeter(remoteID);
  }

  /////////////////////////////////////////////////////
  // Draw audio meter
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
  // Chat: append message
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
    const msgObj = {
      type: 'chat',
      from: 'studio',
      name: 'Studio',
      message: text,
      target: 'all',
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
