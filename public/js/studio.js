/**
 * public/js/studio.js
 *
 * - As soon as the studio page loads, we immediately request mic access
 *   so the VU meter can display real-time levels even before remotes connect.
 * - After mic initialization, we proceed to open the WebSocket, handle
 *   incoming remotes, and so on.
 */

document.addEventListener('DOMContentLoaded', () => {
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

  // peers: Map<remoteId, { pc, entryEl, analyserRec, rafIdRec, mediaStream, muted }>
  const peers = new Map();
  // mediaStreams: Map<remoteId, MediaStream>
  const mediaStreams = new Map();
  // remoteRecorders: Map<remoteId, MediaRecorder>
  const remoteRecorders = new Map();

  // ────────────────────────────────────────────────────────────────────────
  // 2) STUDIO MIC & VU METER SETUP
  // ────────────────────────────────────────────────────────────────────────
  let studioMicStream = null;
  let studioAudioContext = null;
  let studioAnalyser = null;
  let studioRMSData = null;
  let studioRafId = null;

  const studioVuCanvas = document.getElementById('studioVuCanvas');
  const studioVuCtx = studioVuCanvas.getContext('2d');
  const vuWidth = studioVuCanvas.width;
  const vuHeight = studioVuCanvas.height;

  /**
   * Immediately prompt for microphone access and set up a running VU meter.
   * Called as soon as DOMContentLoaded fires—before we even open the WebSocket.
   */
  async function initStudioMic() {
    try {
      studioMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Create an AudioContext & AnalyserNode for the studio mic.
      studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const source = studioAudioContext.createMediaStreamSource(studioMicStream);
      studioAnalyser = studioAudioContext.createAnalyser();
      studioAnalyser.fftSize = 256;
      source.connect(studioAnalyser);
      studioRMSData = new Uint8Array(studioAnalyser.frequencyBinCount);
      // Start drawing the VU meter right away
      drawStudioVuMeter();
      console.log('[studio] Studio mic & VU meter initialized');
    } catch (err) {
      console.error('[studio] Error accessing microphone:', err);
      alert('Microphone access is required to see the studio VU meter.');
    }
  }

  /**
   * Continuously reads from studioAnalyser and draws 10 segmented bars,
   * coloring them green / yellow / red based on level. Runs as soon as
   * initStudioMic() succeeds—no WebSocket needed to begin.
   */
  function drawStudioVuMeter() {
    if (!studioAnalyser) return;
    studioAnalyser.getByteFrequencyData(studioRMSData);
    // Compute RMS across the entire frequency bin
    let sum = 0;
    for (let i = 0; i < studioRMSData.length; i++) {
      sum += studioRMSData[i] * studioRMSData[i];
    }
    const rms = Math.sqrt(sum / studioRMSData.length) / 255; // [0..1]

    // Clear canvas
    studioVuCtx.clearRect(0, 0, vuWidth, vuHeight);

    // Draw 10 segments (bottom-to-top). Fill only those >= RMS.
    const segments = 10;
    const segHeight = vuHeight / segments;
    for (let i = 0; i < segments; i++) {
      const threshold = (i + 1) / segments; // 0.1, 0.2, …, 1.0
      const y = vuHeight - (i + 1) * segHeight;
      if (rms >= threshold) {
        studioVuCtx.fillStyle = pickColorForLevel(threshold);
        studioVuCtx.fillRect(0, y, vuWidth, segHeight - 2);
      } else {
        studioVuCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color');
        studioVuCtx.strokeRect(0, y, vuWidth, segHeight - 2);
      }
    }

    studioRafId = requestAnimationFrame(drawStudioVuMeter);
  }

  /**
   * Helper to pick green / yellow / red based on a normalized [0..1] value
   * (passed as `level`). Colors come from CSS variables.
   */
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
  // 3) GLOBAL CHAT (Broadcast-only)
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
  // 4) WEBSOCKET SIGNALING
  // ────────────────────────────────────────────────────────────────────────
  function initWebSocket() {
    ws = new WebSocket(WS_URL);
    const connStatusSpan = document.getElementById('connStatus');

    ws.onopen = () => {
      console.log('[studio] WS opened');
      connStatusSpan.textContent = 'Connected';
      ws.send(JSON.stringify({ type: 'join', role: 'studio', studioId: window.STUDIO_ID || 'Studio' }));
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
      setTimeout(initWebSocket, 5000);

      // Tear down all peers + remove remote VU meters
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

      case 'chat':
        appendGlobalChatMessage(msg.fromId || 'Remote', msg.text);
        break;

      default:
        console.warn('[studio] Unknown message:', msg.type);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5) SET UP A NEW REMOTE CARD
  // ────────────────────────────────────────────────────────────────────────
  function setupNewRemote(remoteId, remoteName) {
    // 5a) Add a vertical VU meter “card” in the top row
    const vuContainer = document.getElementById('vuMetersContainer');
    const remoteVuCard = document.createElement('div');
    remoteVuCard.className = 'vu-meter-vertical card remote-meter-card';
    remoteVuCard.id = `vuCard-${remoteId}`;
    remoteVuCard.innerHTML = `
      <div class="section-title">${remoteName}</div>
      <canvas class="remoteVuCanvas" width="20" height="150"></canvas>
      <div class="vu-legend">
        <div>10</div>
        <div>8</div>
        <div>6</div>
        <div>4</div>
        <div>2</div>
        <div>0</div>
      </div>
    `;
    vuContainer.appendChild(remoteVuCard);
    const remoteVuCanvas = remoteVuCard.querySelector('.remoteVuCanvas');
    const remoteVuCtx = remoteVuCanvas.getContext('2d');

    // 5b) Clone the 250×150 remote‐entry template
    const clone = document.getElementById('remoteEntryTemplate').content.cloneNode(true);
    const entryEl = clone.querySelector('.remote-entry');
    entryEl.id = `remote-${remoteId}`;
    entryEl.querySelector('.remote-name').textContent = remoteName;
    entryEl.querySelector('.remote-status').textContent = '(waiting)';

    const callBtn = entryEl.querySelector('.callRemoteBtn');
    const muteBtn = entryEl.querySelector('.muteRemoteBtn');
    const modeSelect = entryEl.querySelector('.modeSelect');
    const bitrateInput = entryEl.querySelector('.bitrateInput');
    const toggleStatsBtn = entryEl.querySelector('.toggleStatsBtn');
    const ppmCanvas = entryEl.querySelector('.remote-meter canvas');
    const jitterCanvas = entryEl.querySelector('.jitter-graph canvas');
    const bitrateCanvas = entryEl.querySelector('.bitrate-graph canvas');

    document.getElementById('remotesContainer').appendChild(entryEl);

    // 5c) PeerConnection setup
    const pc = new RTCPeerConnection(ICE_CONFIG);
    let isMuted = false;

    // 5d) Add the studio mic track so the remote can hear us
    if (studioMicStream) {
      studioMicStream.getAudioTracks().forEach((t) => pc.addTrack(t, studioMicStream));
    }

    // 5e) ontrack: remote’s audio → drive the remote’s VU meter
    pc.ontrack = (evt) => {
      const [remoteStream] = evt.streams;
      entryEl.querySelector('.remote-status').textContent = '(connected)';

      // If we haven’t already created an analyser for this remote, do so now:
      if (!peers.get(remoteId).analyserRec) {
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

          remoteVuCtx.clearRect(0, 0, vuWidth, vuHeight);
          const segments = 10;
          const segHeight = vuHeight / segments;
          for (let i = 0; i < segments; i++) {
            const threshold = (i + 1) / segments;
            const color = pickColorForLevel(threshold);
            const y = vuHeight - (i + 1) * segHeight;
            if (rms >= threshold) {
              remoteVuCtx.fillStyle = color;
              remoteVuCtx.fillRect(0, y, vuWidth, segHeight - 2);
            } else {
              remoteVuCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-color');
              remoteVuCtx.strokeRect(0, y, vuWidth, segHeight - 2);
            }
          }
          const raf = requestAnimationFrame(drawRemoteVu);
          peers.get(remoteId).rafIdRec = raf;
        }
        drawRemoteVu();

        const peerData = peers.get(remoteId);
        peerData.analyserRec = analyserRec;
        peerData.rmsDataRec = rmsDataRec;
        peerData.mediaStream = remoteStream;
      }
    };

    // 5f) ICE candidate → server
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

    // 5g) Connection state changes → teardown if closed/failed
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (['disconnected', 'failed', 'closed'].includes(state)) {
        teardownPeer(remoteId);
      }
    };

    // 5h) Store data in the map
    peers.set(remoteId, {
      pc,
      entryEl,
      analyserRec: null,
      rmsDataRec: null,
      rafIdRec: null,
      mediaStream: null,
      muted: false,
    });

    // 5i) Button Handlers

    // Call button: send “ready-for-offer”
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

    // Bitrate change
    bitrateInput.onchange = () => {
      const br = parseInt(bitrateInput.value, 10);
      ws.send(
        JSON.stringify({
          type: 'bitrate-update',
          target: remoteId,
          bitrate: br,
        })
      );
    };

    // Toggle Stats: show/hide PPM / Jitter / Bitrate graphs
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
  // 6) HANDLE INCOMING OFFER FROM REMOTE
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
  // 7) HANDLE INCOMING ICE CANDIDATE
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
  // 8) TEARDOWN A REMOTE
  // ────────────────────────────────────────────────────────────────────────
  function teardownPeer(remoteId) {
    const data = peers.get(remoteId);
    if (!data) return;
    const { pc, entryEl, rafIdRec } = data;
    if (rafIdRec) cancelAnimationFrame(rafIdRec);
    if (pc) pc.close();
    if (entryEl && document.getElementById('remotesContainer').contains(entryEl)) {
      entryEl.remove();
    }
    // Also remove the VU meter “card”
    const vuCard = document.getElementById(`vuCard-${remoteId}`);
    if (vuCard) vuCard.remove();
    peers.delete(remoteId);
    mediaStreams.delete(remoteId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 9) RECORDING CONTROLS (Unchanged from before)
  // ────────────────────────────────────────────────────────────────────────
  const recordBtn = document.getElementById('recordBtn');
  const stopRecordBtn = document.getElementById('stopRecordBtn');
  const recorderTimerSpan = document.getElementById('recTimer');
  const waveformCanvas = document.getElementById('waveformCanvas');

  let studioRecorder = null;
  let recordingStartTime = null;
  let recorderTimerInterval = null;

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
      masterDestination = studioAudioContext.createMediaStreamDestination();
    }
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
  // 10) INITIALIZATION: Mic first, then WebSocket
  // ────────────────────────────────────────────────────────────────────────
  (async () => {
    // 10a) Immediately request mic access and start VU meter
    await initStudioMic();
    // 10b) Then open the WebSocket and handle remotes
    initWebSocket();
  })();
});
