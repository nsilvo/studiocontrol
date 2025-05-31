/**
 * studio.js
 *
 * Front-end logic for the studio control interface (v10).
 * - Studio can select remote audio bitrate.
 * - Adds bitrate and jitter graphs per connected remote.
 * - Existing PPM meters remain.
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
  //   meterCanvas, meterContext, analyserL, analyserR, ppmPeak,
  //   bitrateSelector, bitrateCanvas, bitrateContext,
  //   jitterCanvas, jitterContext,
  //   stats: { lastBytes, lastTimestamp, bitrateData[], jitterData[] },
  //   statsInterval,
  //   statusSpan, muteBtn, kickBtn, remoteMuted, localMuted
  // }
  const peers = new Map();

  const waitingListEl = document.getElementById('waiting-list');
  const contributorListEl = document.getElementById('contributors-list');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  // Studio mic PPM meter
  const studioMeterCanvas = document.getElementById('studio-meter');
  const studioMeterCtx = studioMeterCanvas.getContext('2d');
  let studioAudioStream = null, studioAnalyser = null, studioPPMPeak = 0;
  let studioAudioTrack = null;

  /////////////////////////////////////////////////////
  // Initialization
  /////////////////////////////////////////////////////
  async function init() {
    await initStudioMicPPM();
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
  // Handle signaling messages
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
        alert(`You have been disconnected by the studio:\\n\\n${msg.reason}`);
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
  // Initialize Studio mic PPM
  /////////////////////////////////////////////////////
  async function initStudioMicPPM() {
    try {
      studioAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('Studio mic access error:', err);
      return;
    }
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(studioAudioStream);
    studioAnalyser = audioCtx.createAnalyser();
    studioAnalyser.fftSize = 1024;
    source.connect(studioAnalyser);
    studioAudioTrack = studioAudioStream.getAudioTracks()[0];
    drawStudioPPM();
  }

  function drawStudioPPM() {
    const bufferLength = studioAnalyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    studioAnalyser.getFloatTimeDomainData(dataArray);
    let maxAmp = 0;
    for (let i = 0; i < bufferLength; i++) {
      const absVal = Math.abs(dataArray[i]);
      if (absVal > maxAmp) maxAmp = absVal;
    }
    if (maxAmp > studioPPMPeak) studioPPMPeak = maxAmp;
    else studioPPMPeak = Math.max(studioPPMPeak - 0.005, 0);

    const width = studioMeterCanvas.width;
    const height = studioMeterCanvas.height;
    studioMeterCtx.clearRect(0, 0, width, height);

    // Numeric scale 0.00 to 1.00
    studioMeterCtx.fillStyle = '#fff';
    studioMeterCtx.font = '10px sans-serif';
    studioMeterCtx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * width;
      studioMeterCtx.fillRect(x, height - 10, 1, 10);
      const label = (i / 4).toFixed(2);
      studioMeterCtx.fillText(label, x, height - 12);
    }

    // Current level
    const levelWidth = maxAmp * width;
    studioMeterCtx.fillStyle = '#4caf50';
    studioMeterCtx.fillRect(0, 0, levelWidth, height - 12);

    // Peak hold line
    const peakX = studioPPMPeak * width;
    studioMeterCtx.fillStyle = '#f44336';
    studioMeterCtx.fillRect(peakX - 1, 0, 2, height - 12);

    requestAnimationFrame(drawStudioPPM);
  }

  /////////////////////////////////////////////////////
  // Add a remote to UI
  /////////////////////////////////////////////////////
  function addRemoteToUI(remoteID, remoteName, state) {
    if (peers.has(remoteID)) return;

    const entry = {
      state,
      pendingCandidates: [],
      ppmPeak: 0,
      liWaiting: null,
      liConnected: null,
      pc: null,
      analyserL: null,
      analyserR: null,
      bitrateSelector: null,
      stats: { lastBytes: 0, lastTimestamp: 0, bitrateData: [], jitterData: [] },
      statsInterval: null,
    };

    // Waiting UI
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
      entry.liWaiting = liWait;
      waitingListEl.appendChild(liWait);
    }

    peers.set(remoteID, entry);

    if (state === 'connected') {
      if (entry.liWaiting) {
        entry.liWaiting.remove();
        entry.liWaiting = null;
      }
      addConnectedUI(remoteID);
    }
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
  // Create Connected UI (with bitrate selector and graphs)
  /////////////////////////////////////////////////////
  function addConnectedUI(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;
    if (entry.liConnected) return; // Already exists

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

    // Bitrate selector
    const bitrateLabel = document.createElement('label');
    bitrateLabel.textContent = 'Bitrate:';
    liConn.appendChild(bitrateLabel);

    const bitrateSelector = document.createElement('select');
    bitrateSelector.className = 'bitrate-select';
    bitrateSelector.id = `bitrateSelector-${remoteID}`;
    [
      { value: 32000, text: 'Voice (32 kbps)' },
      { value: 64000, text: 'Standard (64 kbps)' },
      { value: 128000, text: 'High Music (128 kbps)' },
    ].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.text;
      bitrateSelector.appendChild(o);
    });
    bitrateSelector.onchange = () => {
      const br = parseInt(bitrateSelector.value, 10);
      ws.send(
        JSON.stringify({
          type: 'bitrate-update',
          from: 'studio',
          target: remoteID,
          bitrate: br,
        })
      );
    };
    liConn.appendChild(bitrateSelector);
    entry.bitrateSelector = bitrateSelector;

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

    // Bitrate graph label & canvas
    const brLabel = document.createElement('div');
    brLabel.textContent = 'Bitrate (kbps)';
    liConn.appendChild(brLabel);

    const bitrateCanvas = document.createElement('canvas');
    bitrateCanvas.width = 300;
    bitrateCanvas.height = 100;
    bitrateCanvas.className = 'graph-canvas';
    bitrateCanvas.id = `bitrate-${remoteID}`;
    liConn.appendChild(bitrateCanvas);
    entry.bitrateCanvas = bitrateCanvas;
    entry.bitrateContext = bitrateCanvas.getContext('2d');

    // Jitter graph label & canvas
    const jitLabel = document.createElement('div');
    jitLabel.textContent = 'Jitter (ms)';
    liConn.appendChild(jitLabel);

    const jitterCanvas = document.createElement('canvas');
    jitterCanvas.width = 300;
    jitterCanvas.height = 100;
    jitterCanvas.className = 'graph-canvas';
    jitterCanvas.id = `jitter-${remoteID}`;
    liConn.appendChild(jitterCanvas);
    entry.jitterCanvas = jitterCanvas;
    entry.jitterContext = jitterCanvas.getContext('2d');

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

    entry.analyserL = null;
    entry.analyserR = null;

    entry.muteBtn.disabled = false;
  }

  /////////////////////////////////////////////////////
  // Remove a remote
  /////////////////////////////////////////////////////
  function removeRemote(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;
    if (entry.pc) {
      entry.pc.close();
      entry.pc = null;
    }
    if (entry.statsInterval) {
      clearInterval(entry.statsInterval);
      entry.statsInterval = null;
    }
    if (entry.audioElementRemoteToStudio) {
      entry.audioElementRemoteToStudio.srcObject = null;
      entry.audioElementRemoteToStudio.remove();
    }
    if (entry.audioElementStudioToRemote) {
      entry.audioElementStudioToRemote.srcObject = null;
      entry.audioElementStudioToRemote.remove();
    }
    if (entry.liWaiting) entry.liWaiting.remove();
    if (entry.liConnected) entry.liConnected.remove();
    if (entry.meterCanvas) entry.meterCanvas.remove();
    if (entry.bitrateCanvas) entry.bitrateCanvas.remove();
    if (entry.jitterCanvas) entry.jitterCanvas.remove();
    peers.delete(remoteID);
  }

  /////////////////////////////////////////////////////
  // Handle offer from remote
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    if (!studioAudioTrack && studioAudioStream) {
      studioAudioTrack = studioAudioStream.getAudioTracks()[0];
    }

    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      if (studioAudioTrack) {
        pc.addTrack(
          studioAudioTrack,
          studioAudioStream || new MediaStream([studioAudioTrack])
        );
      }

      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        if (!entry.audioElementRemoteToStudio) {
          addConnectedUI(remoteID);
        }
        if (!entry.audioElementRemoteToStudio.srcObject) {
          entry.audioElementRemoteToStudio.srcObject = incomingStream;
          setupRemotePPM(remoteID, incomingStream);
        } else if (
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
        if (state === 'connected') startStats(remoteID);
        if (['disconnected', 'failed', 'closed'].includes(state) && entry.statsInterval) {
          clearInterval(entry.statsInterval);
          entry.statsInterval = null;
        }
      };
    }

    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    } catch (err) {
      console.error(`Failed to set remote desc for ${remoteID}:`, err);
      return;
    }

    if (entry.pendingCandidates.length) {
      entry.pendingCandidates.forEach((c) => {
        entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) => {
          console.error('Error adding queued ICE candidate:', e);
        });
      });
      entry.pendingCandidates = [];
    }

    let answer;
    try {
      answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
    } catch (err) {
      console.error(`Failed to create/set answer for ${remoteID}:`, err);
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
  // Handle ICE candidate
  /////////////////////////////////////////////////////
  function handleCandidate(from, candidate) {
    const entry = peers.get(from);
    if (!entry) return;
    if (!entry.pc || !entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
      console.error(`Error adding ICE candidate for ${from}:`, err);
    });
  }

  /////////////////////////////////////////////////////
  // Handle mute-update
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
  // Parse Opus info
  /////////////////////////////////////////////////////
  function parseOpusInfo(sdp) {
    const lines = sdp.split('\\n');
    let opusPayloadType = null;
    const fmtMap = new Map();
    let sampling = null, channels = null;

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
    return opusPayloadType && fmtMap.has(opusPayloadType) ? fmtMap.get(opusPayloadType) : null;
  }

  /////////////////////////////////////////////////////
  // Setup PPM meter for remote
  /////////////////////////////////////////////////////
  function setupRemotePPM(remoteID, stream) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);

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

  function drawRemotePPM(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || !entry.analyserL || !entry.analyserR) return;

    const canvas = entry.meterCanvas;
    const ctx = entry.meterContext;
    const width = canvas.width;
    const height = canvas.height;

    // Numeric scale 0.00 to 1.00
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * width;
      ctx.fillRect(x, height - 10, 1, 10);
      const label = (i / 4).toFixed(2);
      ctx.fillText(label, x, height - 12);
    }

    const bufferLength = entry.analyserL.fftSize;
    const dataL = new Float32Array(bufferLength);
    const dataR = new Float32Array(bufferLength);
    entry.analyserL.getFloatTimeDomainData(dataL);
    entry.analyserR.getFloatTimeDomainData(dataR);

    let maxAmp = 0;
    for (let i = 0; i < bufferLength; i++) {
      const aL = Math.abs(dataL[i]);
      const aR = Math.abs(dataR[i]);
      if (aL > maxAmp) maxAmp = aL;
      if (aR > maxAmp) maxAmp = aR;
    }

    if (maxAmp > entry.ppmPeak) entry.ppmPeak = maxAmp;
    else entry.ppmPeak = Math.max(entry.ppmPeak - 0.005, 0);

    const levelWidth = maxAmp * width;
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(0, 0, levelWidth, height - 12);

    const peakX = entry.ppmPeak * width;
    ctx.fillStyle = '#f44336';
    ctx.fillRect(peakX - 1, 0, 2, height - 12);

    requestAnimationFrame(() => drawRemotePPM(remoteID));
  }

  /////////////////////////////////////////////////////
  // Start stats polling for bitrate & jitter
  /////////////////////////////////////////////////////
  function startStats(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || !entry.pc) return;
    entry.stats = { lastBytes: 0, lastTimestamp: 0, bitrateData: [], jitterData: [] };
    entry.statsInterval = setInterval(async () => {
      const stats = await entry.pc.getStats();
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          const now = report.timestamp;
          const bytes = report.bytesReceived;
          if (entry.stats.lastTimestamp) {
            const deltaBytes = bytes - entry.stats.lastBytes;
            const deltaTime = (now - entry.stats.lastTimestamp) / 1000; // ms→s
            const bitrate = (deltaBytes * 8) / deltaTime; // bps
            entry.stats.bitrateData.push(bitrate / 1000); // kbps
            if (entry.stats.bitrateData.length > 60) entry.stats.bitrateData.shift();
          }
          entry.stats.lastBytes = bytes;
          entry.stats.lastTimestamp = now;
          const jitter = report.jitter * 1000; // seconds→ms
          entry.stats.jitterData.push(jitter);
          if (entry.stats.jitterData.length > 60) entry.stats.jitterData.shift();
        }
      });
      drawStatsGraphs(remoteID);
    }, 1000);
  }

  function drawStatsGraphs(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    // Bitrate graph
    const bCtx = entry.bitrateContext;
    const bCanvas = entry.bitrateCanvas;
    const width = bCanvas.width;
    const height = bCanvas.height;
    const data = entry.stats.bitrateData;

    bCtx.clearRect(0, 0, width, height);
    bCtx.strokeStyle = '#4caf50';
    bCtx.beginPath();
    data.forEach((val, i) => {
      const x = (i / 59) * width;
      const y = height - Math.min(val / 200 * height, height); // scale max 200 kbps
      i === 0 ? bCtx.moveTo(x, y) : bCtx.lineTo(x, y);
    });
    bCtx.stroke();

    // Jitter graph
    const jCtx = entry.jitterContext;
    const jCanvas = entry.jitterCanvas;
    const jData = entry.stats.jitterData;

    jCtx.clearRect(0, 0, width, height);
    jCtx.strokeStyle = '#2196f3';
    jCtx.beginPath();
    jData.forEach((val, i) => {
      const x = (i / 59) * width;
      const y = height - Math.min(val / 100 * height, height); // scale max 100 ms
      i === 0 ? jCtx.moveTo(x, y) : jCtx.lineTo(x, y);
    });
    jCtx.stroke();
  }

  /////////////////////////////////////////////////////
  // Handle offer from remote
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    if (!studioAudioTrack && studioAudioStream) {
      studioAudioTrack = studioAudioStream.getAudioTracks()[0];
    }

    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      if (studioAudioTrack) {
        pc.addTrack(
          studioAudioTrack,
          studioAudioStream || new MediaStream([studioAudioTrack])
        );
      }

      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        if (!entry.audioElementRemoteToStudio) {
          addConnectedUI(remoteID);
        }
        if (!entry.audioElementRemoteToStudio.srcObject) {
          entry.audioElementRemoteToStudio.srcObject = incomingStream;
          setupRemotePPM(remoteID, incomingStream);
        } else if (
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
        if (state === 'connected') startStats(remoteID);
        if (['disconnected', 'failed', 'closed'].includes(state) && entry.statsInterval) {
          clearInterval(entry.statsInterval);
          entry.statsInterval = null;
        }
      };
    }

    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    } catch (err) {
      console.error(`Failed to set remote desc for ${remoteID}:`, err);
      return;
    }

    if (entry.pendingCandidates.length) {
      entry.pendingCandidates.forEach((c) => {
        entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) => {
          console.error('Error adding queued ICE candidate:', e);
        });
      });
      entry.pendingCandidates = [];
    }

    let answer;
    try {
      answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
    } catch (err) {
      console.error(`Failed to create/set answer for ${remoteID}:`, err);
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
  // Handle ICE candidate
  /////////////////////////////////////////////////////
  function handleCandidate(from, candidate) {
    const entry = peers.get(from);
    if (!entry) return;
    if (!entry.pc || !entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
      console.error(`Error adding ICE candidate for ${from}:`, err);
    });
  }

  /////////////////////////////////////////////////////
  // Handle mute-update
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
  // Parse Opus info
  /////////////////////////////////////////////////////
  function parseOpusInfo(sdp) {
    const lines = sdp.split('\\n');
    let opusPayloadType = null;
    const fmtMap = new Map();
    let sampling = null, channels = null;

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
    return opusPayloadType && fmtMap.has(opusPayloadType) ? fmtMap.get(opusPayloadType) : null;
  }

  /////////////////////////////////////////////////////
  // Setup PPM meter for remote
  /////////////////////////////////////////////////////
  function setupRemotePPM(remoteID, stream) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);

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

  function drawRemotePPM(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || !entry.analyserL || !entry.analyserR) return;

    const canvas = entry.meterCanvas;
    const ctx = entry.meterContext;
    const width = canvas.width;
    const height = canvas.height;

    // Numeric scale 0.00 to 1.00
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * width;
      ctx.fillRect(x, height - 10, 1, 10);
      const label = (i / 4).toFixed(2);
      ctx.fillText(label, x, height - 12);
    }

    const bufferLength = entry.analyserL.fftSize;
    const dataL = new Float32Array(bufferLength);
    const dataR = new Float32Array(bufferLength);
    entry.analyserL.getFloatTimeDomainData(dataL);
    entry.analyserR.getFloatTimeDomainData(dataR);

    let maxAmp = 0;
    for (let i = 0; i < bufferLength; i++) {
      const aL = Math.abs(dataL[i]);
      const aR = Math.abs(dataR[i]);
      if (aL > maxAmp) maxAmp = aL;
      if (aR > maxAmp) maxAmp = aR;
    }

    if (maxAmp > entry.ppmPeak) entry.ppmPeak = maxAmp;
    else entry.ppmPeak = Math.max(entry.ppmPeak - 0.005, 0);

    const levelWidth = maxAmp * width;
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(0, 0, levelWidth, height - 12);

    const peakX = entry.ppmPeak * width;
    ctx.fillStyle = '#f44336';
    ctx.fillRect(peakX - 1, 0, 2, height - 12);

    requestAnimationFrame(() => drawRemotePPM(remoteID));
  }

  /////////////////////////////////////////////////////
  // Start stats polling for bitrate & jitter
  /////////////////////////////////////////////////////
  function startStats(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || !entry.pc) return;
    entry.stats = { lastBytes: 0, lastTimestamp: 0, bitrateData: [], jitterData: [] };
    entry.statsInterval = setInterval(async () => {
      const stats = await entry.pc.getStats();
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          const now = report.timestamp;
          const bytes = report.bytesReceived;
          if (entry.stats.lastTimestamp) {
            const deltaBytes = bytes - entry.stats.lastBytes;
            const deltaTime = (now - entry.stats.lastTimestamp) / 1000; // ms→s
            const bitrate = (deltaBytes * 8) / deltaTime; // bps
            entry.stats.bitrateData.push(bitrate / 1000); // kbps
            if (entry.stats.bitrateData.length > 60) entry.stats.bitrateData.shift();
          }
          entry.stats.lastBytes = bytes;
          entry.stats.lastTimestamp = now;
          const jitter = report.jitter * 1000; // seconds→ms
          entry.stats.jitterData.push(jitter);
          if (entry.stats.jitterData.length > 60) entry.stats.jitterData.shift();
        }
      });
      drawStatsGraphs(remoteID);
    }, 1000);
  }

  function drawStatsGraphs(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    // Bitrate graph
    const bCtx = entry.bitrateContext;
    const bCanvas = entry.bitrateCanvas;
    const width = bCanvas.width;
    const height = bCanvas.height;
    const data = entry.stats.bitrateData;

    bCtx.clearRect(0, 0, width, height);
    bCtx.strokeStyle = '#4caf50';
    bCtx.beginPath();
    data.forEach((val, i) => {
      const x = (i / 59) * width;
      const y = height - Math.min(val / 200 * height, height); // scale max 200 kbps
      i === 0 ? bCtx.moveTo(x, y) : bCtx.lineTo(x, y);
    });
    bCtx.stroke();

    // Jitter graph
    const jCtx = entry.jitterContext;
    const jCanvas = entry.jitterCanvas;
    const jData = entry.stats.jitterData;

    jCtx.clearRect(0, 0, width, height);
    jCtx.strokeStyle = '#2196f3';
    jCtx.beginPath();
    jData.forEach((val, i) => {
      const x = (i / 59) * width;
      const y = height - Math.min(val / 100 * height, height); // scale max 100 ms
      i === 0 ? jCtx.moveTo(x, y) : jCtx.lineTo(x, y);
    });
    jCtx.stroke();
  }

  /////////////////////////////////////////////////////
  // Handle offer from remote
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    if (!studioAudioTrack && studioAudioStream) {
      studioAudioTrack = studioAudioStream.getAudioTracks()[0];
    }

    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      if (studioAudioTrack) {
        pc.addTrack(
          studioAudioTrack,
          studioAudioStream || new MediaStream([studioAudioTrack])
        );
      }

      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;
        if (!entry.audioElementRemoteToStudio) {
          addConnectedUI(remoteID);
        }
        if (!entry.audioElementRemoteToStudio.srcObject) {
          entry.audioElementRemoteToStudio.srcObject = incomingStream;
          setupRemotePPM(remoteID, incomingStream);
        } else if (
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
        if (state === 'connected') startStats(remoteID);
        if (['disconnected', 'failed', 'closed'].includes(state) && entry.statsInterval) {
          clearInterval(entry.statsInterval);
          entry.statsInterval = null;
        }
      };
    }

    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    } catch (err) {
      console.error(`Failed to set remote desc for ${remoteID}:`, err);
      return;
    }

    if (entry.pendingCandidates.length) {
      entry.pendingCandidates.forEach((c) => {
        entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) => {
          console.error('Error adding queued ICE candidate:', e);
        });
      });
      entry.pendingCandidates = [];
    }

    let answer;
    try {
      answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
    } catch (err) {
      console.error(`Failed to create/set answer for ${remoteID}:`, err);
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
  // Handle ICE candidate
  /////////////////////////////////////////////////////
  function handleCandidate(from, candidate) {
    const entry = peers.get(from);
    if (!entry) return;
    if (!entry.pc || !entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
      console.error(`Error adding ICE candidate for ${from}:`, err);
    });
  }

  /////////////////////////////////////////////////////
  // Handle mute-update
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
  // Parse Opus info
  /////////////////////////////////////////////////////
  function parseOpusInfo(sdp) {
    const lines = sdp.split('\\n');
    let opusPayloadType = null;
    const fmtMap = new Map();
    let sampling = null, channels = null;

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
    return opusPayloadType && fmtMap.has(opusPayloadType) ? fmtMap.get(opusPayloadType) : null;
  }

  /////////////////////////////////////////////////////
  // Setup PPM meter for remote
  /////////////////////////////////////////////////////
  function setupRemotePPM(remoteID, stream) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);

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
  // drawRemotePPM remains above
  /////////////////////////////////////////////////////

  /////////////////////////////////////////////////////
  // startStats remains above
  /////////////////////////////////////////////////////

  /////////////////////////////////////////////////////
  // drawStatsGraphs remains above
  /////////////////////////////////////////////////////

  /////////////////////////////////////////////////////
  // appendChatMessage
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
