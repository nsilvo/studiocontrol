/**
 * studio.js
 *
 * Front-end logic for the studio control interface (v4).
 * - Captures studio microphone (two-way audio).
 * - Adds studio audio track into every RTCPeerConnection so remotes hear studio.
 * - Supports waiting/connections.
 * - “Mute” per-remote now does two things:
 *     1) Mutes that remote’s audio locally (remote → studio).
 *     2) Sends a `mute-update` to that remote so they see “Muted by Studio.”
 * - Also listens for remote’s `mute-update` so UI shows “Remote Muted.”
 * - Allows “Kick” to forcibly remove a remote.
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
  //   audioElementRemoteToStudio, // remote → studio audio
  //   audioElementStudioToRemote, // studio → remote audio
  //   localStream,                // studio's mic stream
  //   meterCanvas,
  //   analyserL,
  //   analyserR,
  //   meterContext,
  //   statusSpan,
  //   muteBtn,                    // mutes remote → studio
  //   kickBtn,
  //   remoteMuted,                // did remote press their mute?
  //   localMuted                  // did studio press their mute?
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
  let studioMuted = false;

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
        await handleOffer(msg.from, msg.sdp);
        break;

      case 'candidate':
        // { type:'candidate', from: remoteID|studio, candidate }
        await handleCandidate(msg.from, msg.candidate);
        break;

      case 'remote-disconnected':
        // { type:'remote-disconnected', id }
        removeRemote(msg.id);
        break;

      case 'chat':
        // { type:'chat', from, name, message }
        appendChatMessage(msg.name, msg.message, msg.from === 'studio');
        break;

      case 'mute-update':
        // { type:'mute-update', from, muted: true|false }
        handleMuteUpdate(msg.from, msg.muted);
        break;

      case 'kicked':
        // { type:'kicked', reason: '...' }
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

    const entry = { state };

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
    entry.remoteMuted = false; // has the remote muted themself?
    entry.localMuted = false;  // has studio muted this remote?

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
      entry.audioElementRemoteToStudio = null; // <audio> playing remote → studio
      entry.audioElementStudioToRemote = null; // <audio> playing studio → remote
      entry.meterCanvas = null;
      entry.analyserL = null;
      entry.analyserR = null;
      entry.meterContext = null;
      entry.muteBtn = null;
      entry.kickBtn = null;
    } else if (state === 'connected') {
      // (unlikely on fresh page load) move immediately to "connected" UI
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

    // Mute/unmute button (mutes the remote → studio audio locally)
    const muteBtn = document.createElement('button');
    muteBtn.textContent = 'Mute Remote';
    muteBtn.className = 'mute-btn';
    muteBtn.disabled = true; 
    muteBtn.onclick = () => {
      // Toggle entry.localMuted
      entry.localMuted = !entry.localMuted;
      entry.audioElementRemoteToStudio.muted = entry.localMuted;

      // Send mute-update to remote
      ws.send(
        JSON.stringify({
          type: 'mute-update',
          from: 'studio',
          target: remoteID,
          muted: entry.localMuted,
        })
      );

      // Update UI text
      muteBtn.textContent = entry.localMuted ? 'Unmute Remote' : 'Mute Remote';
    };
    liConn.appendChild(muteBtn);
    entry.muteBtn = muteBtn;

    // Kick button
    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Kick';
    kickBtn.className = 'kick-btn';
    kickBtn.style.background = '#dc3545'; // red background
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

    // Hidden audio element to play remote → studio audio
    const audioRemote = document.createElement('audio');
    audioRemote.id = `audio-remote-${remoteID}`;
    audioRemote.autoplay = true;
    audioRemote.controls = false;
    audioRemote.muted = false; // toggled by muteBtn
    document.body.appendChild(audioRemote);
    entry.audioElementRemoteToStudio = audioRemote;

    // Hidden audio element to play studio → remote audio
    const audioStudio = document.createElement('audio');
    audioStudio.id = `audio-studio-${remoteID}`;
    audioStudio.autoplay = true;
    audioStudio.controls = false;
    audioStudio.muted = false; // we can mute ourselves if desired
    document.body.appendChild(audioStudio);
    entry.audioElementStudioToRemote = audioStudio;

    entry.analyserL = null;
    entry.analyserR = null;

    // Enable muteBtn now that UI is ready
    entry.muteBtn.disabled = false;
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
  // Handle an incoming offer from a remote
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    // Ensure studio has microphone access (do it once)
    if (!studioAudioStream) {
      try {
        studioAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        studioAudioTrack = studioAudioStream.getAudioTracks()[0];
      } catch (err) {
        console.error('Studio getUserMedia error:', err);
        return;
      }
    }

    // Create RTCPeerConnection if not exists
    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      // Attach studio → remote audio track
      if (studioAudioTrack) {
        pc.addTrack(studioAudioTrack, studioAudioStream);
      }

      // Parse Opus codec from SDP and append to status
      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      // When remote's audio track arrives (remote → studio)
      pc.ontrack = (evt) => {
        const [remoteStream] = evt.streams;
        // Ensure audio elements/UI exist
        if (!entry.audioElementRemoteToStudio) {
          addConnectedUI(remoteID);
        }
        entry.audioElementRemoteToStudio.srcObject = remoteStream;
        setupMeter(remoteID, remoteStream);
      };

      // Also get studio → remote audio as a track, but we already added that
      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        // Distinguish remote→studio vs studio→remote by track label?
        // In practice, the second track is studio's own track (we added above).
        // For simplicity, if entry.audioElementStudioToRemote exists but has no srcObject, set it:
        if (
          entry.audioElementStudioToRemote &&
          !entry.audioElementStudioToRemote.srcObject &&
          incomingStream.getAudioTracks()[0].id !== studioAudioTrack.id
        ) {
          entry.audioElementStudioToRemote.srcObject = incomingStream;
        } else {
          // It was the remote→studio track, handled above
          if (entry.audioElementRemoteToStudio && !entry.audioElementRemoteToStudio.srcObject) {
            entry.audioElementRemoteToStudio.srcObject = incomingStream;
            setupMeter(remoteID, incomingStream);
          }
        }
      };

      // ICE candidates to remote
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

    // Set remote description
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
  // Handle incoming ICE candidate (from remote or studio)
  /////////////////////////////////////////////////////
  async function handleCandidate(from, candidate) {
    // from === 'studio' means candidate from studio's ICE? Usually we only expect remote→studio here.
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
  // Handle incoming mute-update
  /////////////////////////////////////////////////////
  function handleMuteUpdate(from, muted) {
    // If from is a remoteID, it means the remote muted/unmuted themself
    if (peers.has(from)) {
      const entry = peers.get(from);
      entry.remoteMuted = muted;
      // Disable or re-enable that remote's mute button
      if (muted) {
        entry.muteBtn.textContent = 'Remote Muted';
        entry.muteBtn.disabled = true;
      } else {
        entry.muteBtn.textContent = entry.localMuted ? 'Unmute Remote' : 'Mute Remote';
        entry.muteBtn.disabled = false;
      }
    }
    // If from === 'studio', it means studio's own mute changed—no UI action needed here
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
  // Set up stereo audio meter for an incoming MediaStream (remote → studio)
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
