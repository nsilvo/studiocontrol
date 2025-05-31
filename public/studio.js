/**
 * studio.js
 *
 * Front-end logic for the studio control interface (v3).
 * - Supports waiting/connections as before.
 * - Adds a “Kick” button for connected contributors.
 * - Handles new "kick-remote" messaging.
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

  // Globals
  let ws;
  // peers: remoteID → {
  //   state,
  //   liWaiting,
  //   liConnected,
  //   pc,
  //   audioElement,
  //   meterCanvas,
  //   analyserL,
  //   analyserR,
  //   meterContext,
  //   statusSpan,
  //   muteBtn,
  //   connectBtn,
  //   kickBtn
  // }
  const peers = new Map();

  const waitingListEl = document.getElementById('waiting-list');
  const contributorListEl = document.getElementById('contributors-list');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

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
  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'existing-remotes':
        // { type:'existing-remotes', remotes: [ {id, name, state}, ... ] }
        for (const { id, name, state } of msg.remotes) {
          addRemoteToUI(id, name, state);
        }
        break;

      case 'new-remote':
        // { type:'new-remote', id, name, state:'waiting' }
        addRemoteToUI(msg.id, msg.name, msg.state);
        break;

      case 'remote-state-change':
        // { type:'remote-state-change', id, state }
        updateRemoteState(msg.id, msg.state);
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
        removeRemote(msg.id);
        break;

      case 'chat':
        // { type:'chat', from, name, message }
        appendChatMessage(msg.name, msg.message, msg.from === 'studio');
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

    const entry = {};
    entry.state = state;

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

    if (state === 'waiting') {
      // Create “Connect” button
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
      entry.liConnected = null;
      entry.pc = null;
      entry.audioElement = null;
      entry.analyserL = null;
      entry.analyserR = null;
      entry.meterContext = null;
      entry.muteBtn = null;
      entry.kickBtn = null;
    } else if (state === 'connected') {
      // If server says “connected” right away (unlikely), move to connected UI
      addConnectedUI(remoteID, remoteName);
      entry.liWaiting = null;
      entry.liConnected = document.getElementById(`connected-${remoteID}`);
    }

    peers.set(remoteID, entry);
  }

  /////////////////////////////////////////////////////
  // Update a remote’s state (waiting → connecting → offered → connected)
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
      // Remove from waiting list (if exists)
      if (entry.liWaiting) {
        entry.liWaiting.remove();
        entry.liWaiting = null;
      }
      // Create connected UI
      addConnectedUI(remoteID);
    }
  }

  /////////////////////////////////////////////////////
  // Create the Connected Contributors UI (with Mute & Kick)
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

    // Mute/unmute button
    const muteBtn = document.createElement('button');
    muteBtn.textContent = 'Mute';
    muteBtn.className = 'mute-btn';
    muteBtn.disabled = true; // will enable when audio track arrives
    muteBtn.onclick = () => {
      const peer = peers.get(remoteID);
      if (!peer) return;
      peer.audioElement.muted = !peer.audioElement.muted;
      if (peer.audioElement.muted) {
        muteBtn.textContent = 'Unmute';
        muteBtn.classList.add('active');
      } else {
        muteBtn.textContent = 'Mute';
        muteBtn.classList.remove('active');
      }
    };
    liConn.appendChild(muteBtn);
    entry.muteBtn = muteBtn;

    // Kick button
    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Kick';
    kickBtn.className = 'kick-btn';
    kickBtn.style.background = '#dc3545';     /* red background */
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

    // Meter canvas (stereo: green = left, blue = right)
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

    // Hidden audio element to play remote audio
    const audioEl = document.createElement('audio');
    audioEl.id = `audio-${remoteID}`;
    audioEl.autoplay = true;
    audioEl.controls = false;
    audioEl.muted = false;
    document.body.appendChild(audioEl);
    entry.audioElement = audioEl;

    entry.analyserL = null;
    entry.analyserR = null;
  }

  /////////////////////////////////////////////////////
  // Remove a remote from both UI lists
  /////////////////////////////////////////////////////
  function removeRemote(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    if (entry.pc) {
      entry.pc.close();
    }
    if (entry.audioElement) {
      entry.audioElement.srcObject = null;
      entry.audioElement.remove();
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
  // Handle an incoming offer from a remote
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    // Create RTCPeerConnection if not exists
    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      // Parse Opus codec from SDP and append to status
      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      // When remote track arrives
      pc.ontrack = (evt) => {
        const [remoteStream] = evt.streams;
        entry.audioElement.srcObject = remoteStream;
        setupMeter(remoteID, remoteStream);
        entry.muteBtn.disabled = false;
      };

      // Send ICE candidates to remote
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
    }

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
  // Handle incoming ICE candidate (from remote)
  /////////////////////////////////////////////////////
  async function handleCandidate(from, candidate) {
    if (from === 'studio') return; // not expecting studio→studio
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
  // Parse Opus codec info from SDP (e.g. "Opus 48000Hz/2ch")
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
  // Continuously draw audio meter (green = left, blue = right)
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
  // Chat: append message to chat window
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
