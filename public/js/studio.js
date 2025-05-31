/**
 * public/js/studio.js
 *
 * - Captures studio mic → drives #studioVuCanvas horizontal VU meter.
 * - Captures mixed remote audio → drives #remoteMixVuCanvas horizontal VU meter.
 * - For each remote:
 *     • Creates a horizontal VU‐meter card (300×20) appended to #mainVuContainer.
 *     • Creates a 250×150 remote‐entry card with Call, Mute/Unmute, Mode, BitrateSelect, Toggle Stats.
 * - Single global chat → broadcast to all remotes.
 * - Recording controls unchanged.
 * - WebSocket keepalives every 30s to avoid idle‐timeout drops.
 */

document.addEventListener('DOMContentLoaded', () => {
  // ────────────────────────────────────────────────────────────────────────
  // 0) KEEPALIVE HELPERS (top‐level)
  // ────────────────────────────────────────────────────────────────────────
  let keepaliveIntervalId = null;
  function startKeepalive(ws) {
    if (keepaliveIntervalId) return;
    keepaliveIntervalId = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'keepalive' }));
      }
    }, 30000);
  }
  function stopKeepalive() {
    if (keepaliveIntervalId) {
      clearInterval(keepaliveIntervalId);
      keepaliveIntervalId = null;
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────────────
  // 1) ICE & WS CONFIG
  // ────────────────────────────────────────────────────────────────────────
  const ICE_CONFIG = {
    iceServers: [
      {
        urls: ['turn:turn.nkpa.co.uk:3478'],
        username: 'webrtcuser',
        credential: 'uS2h$2JW!hL3!E9yb1N1',
      },
    ],
  };
  const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
  let ws = null;

  // peers: Map<remoteId, { pc, entryEl, mediaStream, muted, vuRafId }>
  const peers = new Map();
  // mediaStreams: Map<remoteId, MediaStream>
  const mediaStreams = new Map();
  // remoteRecorders: Map<remoteId, MediaRecorder>
  const remoteRecorders = new Map();

  // ────────────────────────────────────────────────────────────────────────
  // 2) STUDIO MIC VU METER (Horizontal)
  // ────────────────────────────────────────────────────────────────────────
  let studioMicStream = null;
  let studioAudioContext = null;
  let studioAnalyser = null;
  let studioRMSData = null;

  const studioVuCanvas = document.getElementById('studioVuCanvas');
  const studioVuCtx = studioVuCanvas.getContext('2d');
  const hVuWidth = studioVuCanvas.width;
  const hVuHeight = studioVuCanvas.height;

  /**
   * Prompt for mic & set up Studio Mic horizontal VU.
   */
  async function initStudioMic() {
    try {
      studioMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const source = studioAudioContext.createMediaStreamSource(studioMicStream);
      studioAnalyser = studioAudioContext.createAnalyser();
      studioAnalyser.fftSize = 256;
      source.connect(studioAnalyser);
      studioRMSData = new Uint8Array(studioAnalyser.frequencyBinCount);
      requestAnimationFrame(drawStudioVuMeter);
      console.log('[studio] Studio mic & horizontal VU meter initialized');
    } catch (err) {
      console.error('[studio] Error accessing microphone:', err);
      alert('Microphone access is required to see the studio VU meter.');
    }
  }

  function drawStudioVuMeter() {
    if (!studioAnalyser) return;
    studioAnalyser.getByteFrequencyData(studioRMSData);
    // Compute RMS of entire spectrum
    let sum = 0;
    for (let i = 0; i < studioRMSData.length; i++) {
      sum += studioRMSData[i] * studioRMSData[i];
    }
    const rms = Math.sqrt(sum / studioRMSData.length) / 255; // 0..1

    // Clear
    studioVuCtx.clearRect(0, 0, hVuWidth, hVuHeight);

    // Draw 10 horizontal segments (left-to-right). Fill those ≤ RMS.
    const segments = 10;
    const segWidth = hVuWidth / segments;
    for (let i = 0; i < segments; i++) {
      const threshold = (i + 1) / segments; // 0.1, 0.2, …, 1.0
      const x = i * segWidth;
      const color = pickColorForLevel(threshold);
      if (rms >= threshold) {
        studioVuCtx.fillStyle = color;
        studioVuCtx.fillRect(x, 0, segWidth - 2, hVuHeight);
      } else {
        studioVuCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color');
        studioVuCtx.strokeRect(x, 0, segWidth - 2, hVuHeight);
      }
    }

    requestAnimationFrame(drawStudioVuMeter);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3) REMOTE MIX VU METER (Horizontal)
  // ────────────────────────────────────────────────────────────────────────
  let remoteAudioContext = null;
  let remoteAnalyser = null;
  let remoteRMSData = null;
  let remoteMixer = null; // GainNode to mix all remote sources

  const remoteMixVuCanvas = document.getElementById('remoteMixVuCanvas');
  const remoteMixVuCtx = remoteMixVuCanvas.getContext('2d');

  function initRemoteMixMeter() {
    remoteAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    remoteMixer = remoteAudioContext.createGain();
    remoteMixer.gain.value = 1.0;
    remoteAnalyser = remoteAudioContext.createAnalyser();
    remoteAnalyser.fftSize = 256;

    // ──▶ Connect mixer to audio output (so studio hears remotes) and analyser (for VU)
    remoteMixer.connect(remoteAudioContext.destination);
    remoteMixer.connect(remoteAnalyser);

    remoteRMSData = new Uint8Array(remoteAnalyser.frequencyBinCount);
    requestAnimationFrame(drawRemoteMixVuMeter);
    console.log('[studio] Remote mix VU meter initialized (and connected to speakers)');
  }

  function drawRemoteMixVuMeter() {
    if (!remoteAnalyser) return;
    remoteAnalyser.getByteFrequencyData(remoteRMSData);
    let sum = 0;
    for (let i = 0; i < remoteRMSData.length; i++) {
      sum += remoteRMSData[i] * remoteRMSData[i];
    }
    const rms = Math.sqrt(sum / remoteRMSData.length) / 255; // 0..1

    remoteMixVuCtx.clearRect(0, 0, hVuWidth, hVuHeight);

    const segments = 10;
    const segWidth = hVuWidth / segments;
    for (let i = 0; i < segments; i++) {
      const threshold = (i + 1) / segments;
      const x = i * segWidth;
      const color = pickColorForLevel(threshold);
      if (rms >= threshold) {
        remoteMixVuCtx.fillStyle = color;
        remoteMixVuCtx.fillRect(x, 0, segWidth - 2, hVuHeight);
      } else {
        remoteMixVuCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color');
        remoteMixVuCtx.strokeRect(x, 0, segWidth - 2, hVuHeight);
      }
    }

    requestAnimationFrame(drawRemoteMixVuMeter);
  }

  function pickColorForLevel(level) {
    if (level < 0.6) {
      return getComputedStyle(document.documentElement).getPropertyValue('--meter-green');
    }
    if (level < 0.8) {
      return getComputedStyle(document.documentElement).getPropertyValue('--meter-yellow');
    }
    return getComputedStyle(document.documentElement).getPropertyValue('--meter-red');
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4) GLOBAL CHAT
  // ────────────────────────────────────────────────────────────────────────
  const chatWindowAll = document.getElementById('chatWindow');
  const chatInputAll = document.getElementById('chatInput');
  const chatSendBtnAll = document.getElementById('sendChatBtn');

  function appendGlobalChatMessage(sender, text) {
    const div = document.createElement('div');
    div.textContent = `[${sender}]: ${text}`;
    chatWindowAll.appendChild(div);
    chatWindowAll.scrollTop = chatWindowAll.scrollHeight;
  }

  chatSendBtnAll.onclick = () => {
    const text = chatInputAll.value.trim();
    if (!text) return;
    // Broadcast to ALL remotes
    ws.send(
      JSON.stringify({
        type: 'chat',
        fromRole: 'studio',
        fromId: window.STUDIO_ID || 'Studio',
        text,
        target: 'all',
      })
    );
    appendGlobalChatMessage('You', text);
    chatInputAll.value = '';
  };

  // ────────────────────────────────────────────────────────────────────────
  // 5) WEBSOCKET SIGNALING
  // ────────────────────────────────────────────────────────────────────────
  function initWebSocket() {
    ws = new WebSocket(WS_URL);
    const connStatusSpan = document.getElementById('connStatus');

    ws.onopen = () => {
      console.log('[studio] WS opened');
      connStatusSpan.textContent = 'Connected';
      ws.send(JSON.stringify({ type: 'join', role: 'studio', studioId: window.STUDIO_ID || 'Studio' }));
      // Start keepalives every 30 seconds
      startKeepalive(ws);
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        console.error('[studio] Invalid JSON:', e);
        return;
      }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      console.warn('[studio] WS closed. Reconnecting in 5s…');
      connStatusSpan.textContent = 'Disconnected. Reconnecting…';
      stopKeepalive();
      setTimeout(initWebSocket, 5000);

      // Tear down all peers + remove remote meters/cards
      peers.forEach((_, pid) => teardownPeer(pid));
      peers.clear();
      mediaStreams.clear();
      document.querySelectorAll('.remote-meter-card').forEach((el) => el.remove());
    };

    ws.onerror = (err) => {
      console.error('[studio] WS error:', err);
      ws.close();
    };
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'new-remote':
        setupNewRemote(msg.id, msg.name);
        break;
      case 'offer':
        if (peers.has(msg.from)) handleOffer(msg.from, msg.sdp);
        break;
      case 'candidate':
        if (peers.has(msg.from) && peers.get(msg.from).pc.remoteDescription) {
          handleCandidate(msg.from, msg.candidate);
        }
        break;
      case 'remote-disconnected':
        teardownPeer(msg.id);
        break;
      case 'chat': {
        // Display remote’s displayName (msg.name) if present, else fallback to UUID
        const sender = msg.name || msg.fromId || 'Remote';
        appendGlobalChatMessage(sender, msg.text);
        break;
      }
      default:
        console.warn('[studio] Unknown message:', msg.type);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 6) SET UP A NEW REMOTE CARD
  // ────────────────────────────────────────────────────────────────────────
  function setupNewRemote(remoteId, remoteName) {
    // 6a) Create a horizontal VU meter “card” for this remote
    const vuContainer = document.getElementById('mainVuContainer');
    const remoteVuCard = document.createElement('div');
    remoteVuCard.className = 'vu-meter-horizontal card remote-meter-card';
    remoteVuCard.id = `vuCard-${remoteId}`;
    remoteVuCard.innerHTML = `
      <div class="section-title">${remoteName}</div>
      <canvas class="remoteVuCanvas" width="300" height="20"></canvas>
      <div class="vu-legend-horizontal">
        <span>0</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span>
      </div>
    `;
    vuContainer.appendChild(remoteVuCard);
    const remoteVuCanvas = remoteVuCard.querySelector('.remoteVuCanvas');
    const remoteVuCtx = remoteVuCanvas.getContext('2d');

    // 6b) Clone 250×150 remote‐entry template
    const clone = document.getElementById('remoteEntryTemplate').content.cloneNode(true);
    const entryEl = clone.querySelector('.remote-entry');
    entryEl.id = `remote-${remoteId}`;
    entryEl.querySelector('.remote-name').textContent = remoteName;
    entryEl.querySelector('.remote-status').textContent = '(waiting)';

    const callBtn = entryEl.querySelector('.callRemoteBtn');
    const muteBtn = entryEl.querySelector('.muteRemoteBtn');
    const modeSelect = entryEl.querySelector('.modeSelect');
    const bitrateSelect = entryEl.querySelector('.bitrateSelect'); // updated
    const toggleStatsBtn = entryEl.querySelector('.toggleStatsBtn');

    document.getElementById('remotesContainer').appendChild(entryEl);

    // 6c) PeerConnection setup
    const pc = new RTCPeerConnection(ICE_CONFIG);
    let isMuted = false;

    // 6d) Add studio mic track so remote hears studio
    if (studioMicStream) {
      studioMicStream.getAudioTracks().forEach((t) => pc.addTrack(t, studioMicStream));
    }

    // 6e) ontrack: remote’s audio → mix into remoteMixer & drive per-remote VU
    pc.ontrack = (evt) => {
      const [remoteStream] = evt.streams;
      entryEl.querySelector('.remote-status').textContent = '(connected)';

      // 6e-i) Mix this remote’s audio into remoteMixer
      if (remoteMixer) {
        const remoteSource = remoteAudioContext.createMediaStreamSource(remoteStream);
        remoteSource.connect(remoteMixer);
      }
      mediaStreams.set(remoteId, remoteStream);

      // 6e-ii) Per-remote horizontal VU
      if (!peers.get(remoteId).vuRafId) {
        // Create a fresh analyser for this remote
        const meterAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        const meterSrc = meterAudioCtx.createMediaStreamSource(remoteStream);
        const analyserRec = meterAudioCtx.createAnalyser();
        analyserRec.fftSize = 256;
        meterSrc.connect(analyserRec);
        const rmsDataRec = new Uint8Array(analyserRec.frequencyBinCount);

        function drawRemoteVu() {
          analyserRec.getByteFrequencyData(rmsDataRec);
          let sum = 0;
          for (let i = 0; i < rmsDataRec.length; i++) sum += rmsDataRec[i] * rmsDataRec[i];
          const rms = Math.sqrt(sum / rmsDataRec.length) / 255;

          // Clear
          remoteVuCtx.clearRect(0, 0, 300, 20);

          // Draw 10 horizontal segments
          const segments = 10;
          const segWidth = 300 / segments;
          for (let i = 0; i < segments; i++) {
            const threshold = (i + 1) / segments;
            const x = i * segWidth;
            const color = pickColorForLevel(threshold);
            if (rms >= threshold) {
              remoteVuCtx.fillStyle = color;
              remoteVuCtx.fillRect(x, 0, segWidth - 2, 20);
            } else {
              remoteVuCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color');
              remoteVuCtx.strokeRect(x, 0, segWidth - 2, 20);
            }
          }
          const rafId = requestAnimationFrame(drawRemoteVu);
          peers.get(remoteId).vuRafId = rafId;
        }
        // Start the loop:
        drawRemoteVu();
      }
    };

    // 6f) ICE candidate → server
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(
          JSON.stringify({
            type: 'candidate',
            from: 'studio',
            target: remoteId,
            candidate: e.candidate,
          })
        );
      }
    };

    // 6g) Connection state
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (['disconnected', 'failed', 'closed'].includes(state)) {
        teardownPeer(remoteId);
      }
    };

    // 6h) Store peer data
    peers.set(remoteId, {
      pc,
      entryEl,
      mediaStream: null,
      muted: false,
      vuRafId: null,
    });

    // 6i) Button Handlers

    // Call (send “ready-for-offer”)
    callBtn.onclick = () => {
      ws.send(JSON.stringify({ type: 'ready-for-offer', target: remoteId }));
      callBtn.disabled = true;
      entryEl.querySelector('.remote-status').textContent = '(calling…)';
    };

    // Mute/Unmute toggle
    muteBtn.onclick = () => {
      const peerData = peers.get(remoteId);
      if (!peerData) return;
      peerData.muted = !peerData.muted;
      ws.send(
        JSON.stringify({
          type: 'mute-remote',
          target: remoteId,
          muted: peerData.muted,
        })
      );
      muteBtn.textContent = peerData.muted ? 'Unmute' : 'Mute';
      entryEl.querySelector('.remote-status').textContent = peerData.muted ? '(muted)' : '(connected)';
    };

    // Mode change
    modeSelect.onchange = () => {
      ws.send(
        JSON.stringify({
          type: 'mode-update',
          target: remoteId,
          mode: modeSelect.value,
        })
      );
    };

    // Bitrate change (dropdown)
    bitrateSelect.onchange = () => {
      const br = parseInt(bitrateSelect.value, 10);
      ws.send(
        JSON.stringify({
          type: 'bitrate-update',
          target: remoteId,
          bitrate: br,
        })
      );
    };

    // Toggle Stats (show/hide PPM / Jitter / Bitrate)
    toggleStatsBtn.onclick = () => {
      const ppmDiv = entryEl.querySelector('.remote-meter');
      const jitDiv = entryEl.querySelector('.jitter-graph');
      const brDiv = entryEl.querySelector('.bitrate-graph');
      [ppmDiv, jitDiv, brDiv].forEach((div) => {
        if (div.style.display === 'none' || div.style.display === '') {
          div.style.display = 'inline-block';
        } else {
          div.style.display = 'none';
        }
      });
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // 7) HANDLE INCOMING OFFER FROM REMOTE
  // ────────────────────────────────────────────────────────────────────────
  async function handleOffer(remoteId, sdp) {
    const data = peers.get(remoteId);
    if (!data) return;
    const pc = data.pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(
        JSON.stringify({
          type: 'answer',
          from: 'studio',
          target: remoteId,
          sdp: pc.localDescription.sdp,
        })
      );
      data.entryEl.querySelector('.remote-status').textContent = '(connected)';
    } catch (err) {
      console.error(`[studio] handleOffer error for ${remoteId}:`, err);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 8) HANDLE INCOMING ICE CANDIDATE
  // ────────────────────────────────────────────────────────────────────────
  async function handleCandidate(remoteId, candidate) {
    const data = peers.get(remoteId);
    if (!data || !data.pc.remoteDescription) return;
    try {
      await data.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(`[studio] addIceCandidate error for ${remoteId}:`, err);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 9) TEARDOWN A REMOTE
  // ────────────────────────────────────────────────────────────────────────
  function teardownPeer(remoteId) {
    const data = peers.get(remoteId);
    if (!data) return;
    const { pc, entryEl, vuRafId } = data;
    if (vuRafId !== null) cancelAnimationFrame(vuRafId);
    if (pc) pc.close();
    if (entryEl && document.getElementById('remotesContainer').contains(entryEl)) {
      entryEl.remove();
    }
    // Remove the per-remote horizontal VU card
    const vuCard = document.getElementById(`vuCard-${remoteId}`);
    if (vuCard) vuCard.remove();
    peers.delete(remoteId);
    mediaStreams.delete(remoteId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 10) RECORDING CONTROLS (unchanged)
  // ────────────────────────────────────────────────────────────────────────
  const recordBtn = document.getElementById('recordBtn');
  const stopRecordBtn = document.getElementById('stopRecordBtn');
  const recorderTimerSpan = document.getElementById('recTimer');
  const waveformCanvas = document.getElementById('waveformCanvas');

  let studioRecorder = null;
  let recordingStartTime = null;
  let recorderTimerInterval = null;
  let masterDestination = null;

  recordBtn.onclick = () => startRecording();
  stopRecordBtn.onclick = () => stopRecording();

  function startRecording() {
    if (mediaStreams.size === 0) {
      alert('No remotes connected.');
      return;
    }
    recordBtn.disabled = true;
    stopRecordBtn.disabled = false;
    if (!studioAudioContext) {
      studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    }
    // Master destination on studioAudioContext for mix recording
    masterDestination = studioAudioContext.createMediaStreamDestination();

    // Each remote → connect to masterDestination
    mediaStreams.forEach((stream, remoteId) => {
      const src = studioAudioContext.createMediaStreamSource(stream);
      src.connect(masterDestination);
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        uploadBlob(blob, `remote-${remoteId}-${Date.now()}.webm`);
      };
      recorder.start();
      remoteRecorders.set(remoteId, recorder);
    });

    // Record mixed studio + remote mix
    studioRecorder = new MediaRecorder(masterDestination.stream, { mimeType: 'audio/webm' });
    const studioChunks = [];
    studioRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) studioChunks.push(e.data);
    };
    studioRecorder.onstop = () => {
      const blob = new Blob(studioChunks, { type: 'audio/webm' });
      uploadBlob(blob, `studio-mix-${Date.now()}.webm`);
    };
    studioRecorder.start();

    recordingStartTime = Date.now();
    recorderTimerInterval = setInterval(updateTimer, 1000);
  }

  function stopRecording() {
    remoteRecorders.forEach((rec) => {
      if (rec && rec.state !== 'inactive') rec.stop();
    });
    remoteRecorders.clear();
    if (studioRecorder && studioRecorder.state !== 'inactive') {
      studioRecorder.stop();
    }
    clearInterval(recorderTimerInterval);
    recorderTimerSpan.textContent = '00:00';
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
  }

  function updateTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    recorderTimerSpan.textContent = `${mm}:${ss}`;
  }

  function uploadBlob(blob, filename) {
    const form = new FormData();
    form.append('files', new File([blob], filename));
    fetch('/upload', { method: 'POST', body: form })
      .then((res) => res.json())
      .then((json) => {
        console.log('[studio] Uploaded:', json.uploaded);
      })
      .catch((err) => console.error('[studio] Upload error:', err));
  }

  // ────────────────────────────────────────────────────────────────────────
  // 11) INITIALIZATION: Init mic, init remote mix, then WS
  // ────────────────────────────────────────────────────────────────────────
  (async () => {
    await initStudioMic();
    initRemoteMixMeter();
    initWebSocket();
  })();
});
