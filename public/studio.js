/**
 * studio.js
 *
 * Front-end logic for the studio control interface (v9).
 * - Adds number scales (0.00 to 1.00) on PPM meters (studio & remote).
 * - Maintains two-way audio, mutual mute, ICE queuing, and PPM.
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
  // peers: remoteID -> {
  //   state,
  //   liWaiting,
  //   liConnected,
  //   pc,
  //   pendingCandidates,
  //   audioElementRemoteToStudio,
  //   audioElementStudioToRemote,
  //   meterCanvas,
  //   analyserL,
  //   analyserR,
  //   ppmPeak,
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

  // Studio mic PPM meter elements
  const studioMeterCanvas = document.getElementById('studio-meter');
  const studioMeterCtx = studioMeterCanvas.getContext('2d');
  let studioAudioStream = null;
  let studioAnalyser = null;
  let studioPPMPeak = 0;

  // Studio's microphone track for two-way audio
  let studioAudioTrack = null;

  /////////////////////////////////////////////////////
  // Initialize WebSocket and Studio mic meter
  /////////////////////////////////////////////////////
  async function init() {
    initStudioMicPPM();
    initWebSocket();
  }

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
  // Studio mic PPM initialization
  /////////////////////////////////////////////////////
  async function initStudioMicPPM() {
    try {
      // Grab the studio mic for monitoring and for two-way audio
      studioAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('Studio mic access error:', err);
      return;
    }
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(studioAudioStream);

    studioAnalyser = audioCtx.createAnalyser();
    studioAnalyser.fftSize = 1024; // time-domain size
    source.connect(studioAnalyser);

    // Keep the microphone track for adding to each peer
    studioAudioTrack = studioAudioStream.getAudioTracks()[0];

    drawStudioPPM();
  }

  function drawStudioPPM() {
    const bufferLength = studioAnalyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    studioAnalyser.getFloatTimeDomainData(dataArray);

    // Compute peak absolute sample
    let maxAmp = 0;
    for (let i = 0; i < bufferLength; i++) {
      const absVal = Math.abs(dataArray[i]);
      if (absVal > maxAmp) maxAmp = absVal;
    }

    // Peak hold with decay
    if (maxAmp > studioPPMPeak) {
      studioPPMPeak = maxAmp;
    } else {
      studioPPMPeak = Math.max(studioPPMPeak - 0.005, 0);
    }

    // Draw background
    const width = studioMeterCanvas.width;
    const height = studioMeterCanvas.height;
    studioMeterCtx.clearRect(0, 0, width, height);

    // Draw numeric scale (0.00 to 1.00)
    studioMeterCtx.fillStyle = '#fff';
    studioMeterCtx.font = '10px sans-serif';
    studioMeterCtx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * width;
      studioMeterCtx.fillRect(x, height - 10, 1, 10); // tick
      const label = (i / 4).toFixed(2);
      studioMeterCtx.fillText(label, x, height - 12);
    }

    // Draw current level (green)
    const levelWidth = maxAmp * width;
    studioMeterCtx.fillStyle = '#4caf50';
    studioMeterCtx.fillRect(0, 0, levelWidth, height - 12);

    // Draw peak hold line (red)
    const peakX = studioPPMPeak * width;
    studioMeterCtx.fillStyle = '#f44336';
    studioMeterCtx.fillRect(peakX - 1, 0, 2, height - 12);

    requestAnimationFrame(drawStudioPPM);
  }

  /////////////////////////////////////////////////////
  // Add a remote to the UI (waiting or connected)
  /////////////////////////////////////////////////////
  function addRemoteToUI(remoteID, remoteName, state) {
    if (peers.has(remoteID)) return;

    const entry = { state, pendingCandidates: [], ppmPeak: 0 };

    // Build waiting UI
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
      addConnectedUI(remoteID, remoteName);
      entry.liWaiting = null;
      entry.liConnected = document.getElementById(`connected-${remoteID}`);
    }

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
      if (entry.liWaiting) {
        entry.liWaiting.remove();
        entry.liWaiting = null;
      }
      addConnectedUI(remoteID);
    }
  }

  /////////////////////////////////////////////////////
  // Create Connected Contributors UI (with PPM meter)
  /////////////////////////////////////////////////////
  function addConnectedUI(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    // Avoid duplicate UI
    if (entry.liConnected) return;

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
      if (entry.audioElementRemoteToStudio) {
        entry.audioElementRemoteToStudio.muted = entry.localMuted;
      }
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

    // PPM meter canvas
    const meterCanvas = document.createElement('canvas');
    meterCanvas.width = 300;
    meterCanvas.height = 50;
    meterCanvas.className = 'ppm-meter';
    meterCanvas.id = `meter-${remoteID}`;
    liConn.appendChild(meterCanvas);
    entry.meterCanvas = meterCanvas;
    entry.meterContext = meterCanvas.getContext('2d');

    contributorListEl.appendChild(liConn);
    entry.liConnected = liConn;

    // Hidden <audio> for remote→studio
    const audioRemote = document.createElement('audio');
    audioRemote.id = `audio-remote-${remoteID}`;
    audioRemote.autoplay = true;
    audioRemote.controls = false;
    audioRemote.muted = false;
    document.body.appendChild(audioRemote);
    entry.audioElementRemoteToStudio = audioRemote;

    // Hidden <audio> for studio→remote
    const audioStudio = document.createElement('audio');
    audioStudio.id = `audio-studio-${remoteID}`;
    audioStudio.autoplay = true;
    audioStudio.controls = false;
    audioStudio.muted = false;
    document.body.appendChild(audioStudio);
    entry.audioElementStudioToRemote = audioStudio;

    // Initialize analysers after track arrives
    entry.analyserL = null;
    entry.analyserR = null;
    entry.ppmPeak = 0;

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

    // Ensure studio mic track is ready
    if (!studioAudioTrack && studioAudioStream) {
      studioAudioTrack = studioAudioStream.getAudioTracks()[0];
    }

    // Create RTCPeerConnection if needed
    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      // Add studio→remote track
      if (studioAudioTrack) {
        pc.addTrack(
          studioAudioTrack,
          studioAudioStream || new MediaStream([studioAudioTrack])
        );
      }

      // Parse Opus info from SDP offer
      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      // Single ontrack handler
      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        // Ensure UI exists
        if (!entry.audioElementRemoteToStudio) {
          addConnectedUI(remoteID);
        }
        // First track is remote→studio
        if (!entry.audioElementRemoteToStudio.srcObject) {
          entry.audioElementRemoteToStudio.srcObject = incomingStream;
          setupRemotePPM(remoteID, incomingStream);
        }
        // If another track arrives (e.g. studio→remote echo), attach if needed
        else if (
          !entry.audioElementStudioToRemote.srcObject &&
          evt.track.kind === 'audio'
        ) {
          entry.audioElementStudioToRemote.srcObject = incomingStream;
        }
      };

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
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp })
      );
    } catch (err) {
      console.error(`Failed to set remote description for ${remoteID}:`, err);
      return;
    }

    // Drain queued ICE candidates now that remoteDescription is set
    if (entry.pendingCandidates.length > 0) {
      entry.pendingCandidates.forEach((c) => {
        entry.pc
          .addIceCandidate(new RTCIceCandidate(c))
          .catch((e) => console.error('Error adding queued ICE candidate:', e));
      });
      entry.pendingCandidates = [];
    }

    // Create and send answer
    let answer;
    try {
      answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
    } catch (err) {
      console.error(
        `Failed to create/set local answer for ${remoteID}:`,
        err
      );
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
      return;
    }
    if (!entry.pc || !entry.pc.remoteDescription) {
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
  // Set up PPM for a remote → studio stream
  /////////////////////////////////////////////////////
  function setupRemotePPM(remoteID, stream) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);

    // Extract two channels for stereo
    const splitter = audioCtx.createChannelSplitter(2);
    src.connect(splitter);

    const analyserL = audioCtx.createAnalyser();
    analyserL.fftSize = 1024;
    const analyserR = audioCtx.createAnalyser();
    analyserR.fftSize = 1024;

    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    entry.analyserL = analyserL;
    entry.analyserR = analyserR;
    entry.ppmPeak = 0;

    drawRemotePPM(remoteID);
  }

  /////////////////////////////////////////////////////
  // Draw PPM meter for remote (with number scale)
  /////////////////////////////////////////////////////
  function drawRemotePPM(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || !entry.analyserL || !entry.analyserR) return;

    const canvas = entry.meterCanvas;
    const ctx = entry.meterContext;
    const width = canvas.width;
    const height = canvas.height;

    // Draw numeric scale (0.00 to 1.00)
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * width;
      ctx.fillRect(x, height - 10, 1, 10); // tick
      const label = (i / 4).toFixed(2);
      ctx.fillText(label, x, height - 12);
    }

    const bufferLength = entry.analyserL.fftSize;
    const dataL = new Float32Array(bufferLength);
    const dataR = new Float32Array(bufferLength);
    entry.analyserL.getFloatTimeDomainData(dataL);
    entry.analyserR.getFloatTimeDomainData(dataR);

    // Find max absolute amplitude across both channels
    let maxAmp = 0;
    for (let i = 0; i < bufferLength; i++) {
      const aL = Math.abs(dataL[i]);
      const aR = Math.abs(dataR[i]);
      if (aL > maxAmp) maxAmp = aL;
      if (aR > maxAmp) maxAmp = aR;
    }

    // Peak hold with decay
    if (maxAmp > entry.ppmPeak) {
      entry.ppmPeak = maxAmp;
    } else {
      entry.ppmPeak = Math.max(entry.ppmPeak - 0.005, 0);
    }

    // Draw current level (green)
    const levelWidth = maxAmp * width;
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(0, 0, levelWidth, height - 12);

    // Draw peak hold line (red)
    const peakX = entry.ppmPeak * width;
    ctx.fillStyle = '#f44336';
    ctx.fillRect(peakX - 1, 0, 2, height - 12);

    requestAnimationFrame(() => drawRemotePPM(remoteID));
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

  /////////////////////////////////////////////////////
  // Initialization on page load
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    init();
  });
})();
