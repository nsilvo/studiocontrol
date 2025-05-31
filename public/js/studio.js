/**
 * public/js/studio.js
 *
 * - Manages WebSocket signaling, PeerConnections for multiple remotes.
 * - For each connected remote:
 *   • Inserts a `.remote-entry` into #remotesContainer.
 *   • Creates an AudioContext + two AnalyserNodes to meter left/right channels.
 *   • Draws those meters onto that remote’s <canvas>.
 *   • Provides “Call”, “Mute” & “Kick” buttons.
 * - Implements multi‐track recording (studio mix + each remote) with waveform display & timer.
 * - When recording stops, uploads all recorded blobs to the server at /upload.
 */

document.addEventListener('DOMContentLoaded', () => {
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

  const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
  let ws = null;
  // peers maps peerId → { pc, entryEl, audioContext, analyserL, analyserR, rafId, mediaStream }
  const peers = new Map();

  // DOM references
  const connStatusSpan   = document.getElementById('connStatus');
  const remotesContainer = document.getElementById('remotesContainer');
  const remoteEntryTemplate = document.getElementById('remoteEntryTemplate');

  // Recording controls
  const recordBtn      = document.getElementById('recordBtn');
  const stopRecordBtn  = document.getElementById('stopRecordBtn');
  const recorderTimer  = document.getElementById('recTimer');
  const waveformCanvas = document.getElementById('waveformCanvas');
  let studioAudioContext = null;
  let mixedDestination   = null;
  let studioRecorder     = null;
  const remoteRecorders  = new Map(); // remoteId → MediaRecorder
  const mediaStreams     = new Map(); // remoteId → MediaStream
  let recordingStartTime = null;
  let recorderTimerInterval = null;

  // ────────────────────────────────────────────────────────────────────────
  // 1) INITIALIZE WEBSOCKET
  // ────────────────────────────────────────────────────────────────────────
  function initWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[studio] WS opened');
      connStatusSpan.textContent = 'WS connected';
      ws.send(JSON.stringify({ type: 'join', role: 'studio' }));
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
      connStatusSpan.textContent = 'WS disconnected. Reconnecting…';
      setTimeout(initWebSocket, 5000);
      // Tear down all peers
      for (let pid of peers.keys()) {
        teardownPeer(pid);
      }
    };

    ws.onerror = (err) => {
      console.error('[studio] WS error:', err);
      ws.close();
    };
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'new-remote':
        // { type:'new-remote', id, name }
        console.log(`[studio] Remote joined: ${msg.name} (${msg.id})`);
        setupNewRemote(msg.id, msg.name);
        break;

      case 'offer':
        // { type:'offer', from: remoteId, sdp }
        if (peers.has(msg.from)) {
          await handleOffer(msg.from, msg.sdp);
        }
        break;

      case 'candidate':
        // { type:'candidate', from: remoteId, candidate }
        if (peers.has(msg.from)) {
          await handleCandidate(msg.from, msg.candidate);
        }
        break;

      case 'remote-disconnected':
        // { type:'remote-disconnected', id }
        console.log(`[studio] Remote disconnected: ${msg.id}`);
        teardownPeer(msg.id);
        break;

      default:
        console.warn('[studio] Unknown message:', msg.type);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 2) SET UP A NEW REMOTE ENTRY
  // ────────────────────────────────────────────────────────────────────────
  function setupNewRemote(remoteId, remoteName) {
    // 1) Clone template
    const clone = remoteEntryTemplate.content.cloneNode(true);
    const entryEl = clone.querySelector('.remote-entry');
    entryEl.id = `remote-${remoteId}`;

    const nameEl    = entryEl.querySelector('.remote-name');
    const statusEl  = entryEl.querySelector('.remote-status');
    const callBtn   = entryEl.querySelector('.callRemoteBtn');
    const muteBtn   = entryEl.querySelector('.muteRemoteBtn');
    const kickBtn   = entryEl.querySelector('.kickRemoteBtn');
    const modeSelect= entryEl.querySelector('.modeSelect');
    const bitrateInput = entryEl.querySelector('.bitrateInput');
    const meterCanvas = entryEl.querySelector('.remote-meter canvas');
    const jitterCanvas= entryEl.querySelector('.jitter-graph canvas');
    const bitrateCanvas= entryEl.querySelector('.bitrate-graph canvas');
    const chatWindow  = entryEl.querySelector('.chat-window');
    const chatInput   = entryEl.querySelector('.chat-input');
    const chatSendBtn = entryEl.querySelector('.chat-send-btn');

    nameEl.textContent    = remoteName;
    statusEl.textContent  = 'Waiting…';

    remotesContainer.appendChild(entryEl);

    // 2) Button handlers
    callBtn.onclick = () => {
      ws.send(JSON.stringify({ type: 'ready-for-offer', target: remoteId }));
      callBtn.disabled = true;
      statusEl.textContent = 'Calling…';
    };

    muteBtn.onclick = () => {
      ws.send(JSON.stringify({ type: 'mute-remote', target: remoteId }));
      muteBtn.disabled = true;
      statusEl.textContent = 'Muted';
    };

    kickBtn.onclick = () => {
      ws.send(JSON.stringify({ type: 'kick-remote', target: remoteId }));
      kickBtn.disabled = true;
      statusEl.textContent = 'Kicked';
    };

    modeSelect.onchange = () => {
      ws.send(JSON.stringify({
        type: 'mode-update',
        target: remoteId,
        mode: modeSelect.value
      }));
    };

    bitrateInput.onchange = () => {
      const br = parseInt(bitrateInput.value, 10);
      ws.send(JSON.stringify({
        type: 'bitrate-update',
        target: remoteId,
        bitrate: br
      }));
    };

    chatSendBtn.onclick = () => {
      const text = chatInput.value.trim();
      if (!text) return;
      ws.send(JSON.stringify({
        type: 'chat',
        fromRole: 'studio',
        fromId: 'studio',
        target: 'remote',
        targetId: remoteId,
        text
      }));
      appendChatMessage(chatWindow, 'You', text);
      chatInput.value = '';
    };

    // 3) Set up peer connection placeholders
    const pc = new RTCPeerConnection(ICE_CONFIG);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(JSON.stringify({
          type: 'candidate',
          from: 'studio',
          target: remoteId,
          candidate: e.candidate
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      statusEl.textContent = `WebRTC: ${state}`;
      if (['disconnected', 'failed', 'closed'].includes(state)) {
        teardownPeer(remoteId);
      }
    };

    pc.ontrack = (evt) => {
      const [remoteStream] = evt.streams;
      statusEl.textContent = 'Connected';

      // Store remote stream for recording
      mediaStreams.set(remoteId, remoteStream);

      // Metering setup
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const srcNode = audioCtx.createMediaStreamSource(remoteStream);
      const splitter = audioCtx.createChannelSplitter(2);

      const analyserL = audioCtx.createAnalyser();
      analyserL.fftSize = 256;
      const analyserR = audioCtx.createAnalyser();
      analyserR.fftSize = 256;

      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      // Draw meters
      const meterCtx = meterCanvas.getContext('2d');
      function drawMeter() {
        const bufLen = analyserL.frequencyBinCount;
        const dataL = new Uint8Array(bufLen);
        const dataR = new Uint8Array(bufLen);
        analyserL.getByteFrequencyData(dataL);
        analyserR.getByteFrequencyData(dataR);

        let sumL = 0, sumR = 0;
        for (let i = 0; i < bufLen; i++) {
          sumL += dataL[i] * dataL[i];
          sumR += dataR[i] * dataR[i];
        }
        const rmsL = Math.sqrt(sumL / bufLen) / 255;
        const rmsR = Math.sqrt(sumR / bufLen) / 255;

        meterCtx.clearRect(0, 0, meterCanvas.width, meterCanvas.height);
        const barL = Math.round(rmsL * meterCanvas.width);
        meterCtx.fillStyle = '#4caf50';
        meterCtx.fillRect(0, 0, barL, meterCanvas.height / 2 - 2);
        const barR = Math.round(rmsR * meterCanvas.width);
        meterCtx.fillStyle = '#2196f3';
        meterCtx.fillRect(0, meterCanvas.height / 2 + 2, barR, meterCanvas.height / 2 - 2);

        dataL.fill(0);
        dataR.fill(0);

        requestAnimationFrame(drawMeter);
      }
      drawMeter();

      // Jitter & bitrate graph placeholders (just clear for now)
      const jitterCtx = jitterCanvas.getContext('2d');
      const bitrateCtx= bitrateCanvas.getContext('2d');
      function drawDummy() {
        // In a real setup you'd call getStats() and plot jitter/bitrate over time
        jitterCtx.clearRect(0, 0, jitterCanvas.width, jitterCanvas.height);
        bitrateCtx.clearRect(0, 0, bitrateCanvas.width, bitrateCanvas.height);
        requestAnimationFrame(drawDummy);
      }
      drawDummy();

      // Save peer data
      peers.set(remoteId, {
        pc,
        entryEl,
        audioContext: audioCtx,
        analyserL,
        analyserR,
        rafId: null,
        mediaStream: remoteStream
      });
    };

    // 4) Store the PeerConnection before we get tracks
    peers.set(remoteId, {
      pc,
      entryEl,
      audioContext: null,
      analyserL: null,
      analyserR: null,
      rafId: null,
      mediaStream: null
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3) HANDLE INCOMING OFFER FROM REMOTE
  // ────────────────────────────────────────────────────────────────────────
  async function handleOffer(remoteId, sdp) {
    const data = peers.get(remoteId);
    if (!data) return;
    const pc = data.pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({
        type: 'answer',
        from: 'studio',
        target: remoteId,
        sdp: pc.localDescription.sdp
      }));
    } catch (e) {
      console.error(`[studio] handleOffer error for ${remoteId}:`, e);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4) HANDLE INCOMING ICE CANDIDATE
  // ────────────────────────────────────────────────────────────────────────
  async function handleCandidate(remoteId, candidate) {
    const data = peers.get(remoteId);
    if (!data || !data.pc.remoteDescription) {
      console.warn(`[studio] No PC or remoteDesc for ${remoteId} yet.`);
      return;
    }
    try {
      await data.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error(`[studio] addIceCandidate error for ${remoteId}:`, e);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5) TEARDOWN A REMOTE
  // ────────────────────────────────────────────────────────────────────────
  function teardownPeer(remoteId) {
    const data = peers.get(remoteId);
    if (!data) return;
    const { pc, entryEl, audioContext, rafId } = data;
    if (rafId) cancelAnimationFrame(rafId);
    if (audioContext) audioContext.close();
    if (pc) pc.close();
    if (entryEl && remotesContainer.contains(entryEl)) {
      remotesContainer.removeChild(entryEl);
    }
    peers.delete(remoteId);
    mediaStreams.delete(remoteId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 6) RECORDING CONTROLS
  // ────────────────────────────────────────────────────────────────────────
  recordBtn.onclick = () => startRecording();
  stopRecordBtn.onclick = () => stopRecording();

  function startRecording() {
    if (mediaStreams.size === 0) {
      alert('No remotes connected.');
      return;
    }

    recordBtn.disabled = true;
    stopRecordBtn.disabled = false;

    studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
    mixedDestination = studioAudioContext.createMediaStreamDestination();

    // For each remote, connect its stream to the mixer
    mediaStreams.forEach((stream, remoteId) => {
      const src = studioAudioContext.createMediaStreamSource(stream);
      src.connect(mixedDestination);

      // Also record each remote individually
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      const chunks = [];
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        uploadBlob(blob, `remote-${remoteId}-${Date.now()}.webm`);
      };
      recorder.start();
      remoteRecorders.set(remoteId, recorder);
    });

    // Now record the mixed stream
    studioRecorder = new MediaRecorder(mixedDestination.stream, { mimeType: 'audio/webm' });
    const studioChunks = [];
    studioRecorder.ondataavailable = e => {
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
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;

    remoteRecorders.forEach(rec => {
      if (rec && rec.state !== 'inactive') rec.stop();
    });
    remoteRecorders.clear();

    if (studioRecorder && studioRecorder.state !== 'inactive') {
      studioRecorder.stop();
    }

    clearInterval(recorderTimerInterval);
    recorderTimerSpan.textContent = '00:00';
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
      .then(res => res.json())
      .then(json => {
        console.log('[studio] Uploaded:', json.uploaded);
      })
      .catch(err => console.error('[studio] Upload error:', err));
  }

  // ────────────────────────────────────────────────────────────────────────
  // INITIALIZE EVERYTHING
  // ────────────────────────────────────────────────────────────────────────
  initWebSocket();
});
