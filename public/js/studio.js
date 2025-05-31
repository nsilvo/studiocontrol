/**
 * public/js/studio.js
 *
 * - Manages WebSocket signaling and RTCPeerConnections for multiple remotes.
 * - For each connected remote:
 *     • Creates a remote‐entry card in #remotesContainer.
 *     • Sets up an RTCPeerConnection that receives the remote’s audio
 *       and also sends “studio audio” (the mix of all remotes) back.
 *     • Provides “Call”, “Mute”, “Kick” buttons, Mode and Bitrate controls.
 *     • Draws a per‐remote PPM meter, placeholder jitter/bitrate graphs, and a chat window.
 * - Implements multi-track recording:
 *     • Creates a single “master mixer” AudioContext that mixes all remote streams.
 *     • Sends that mixed stream as an outgoing track to each remote’s PC.
 *     • Records each remote’s audio individually, plus the mixed “studio feed”,
 *       and uploads them via POST /upload when recording stops.
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

  // peers: Map<remoteId, { pc, entryEl, audioContext, analyserL, analyserR, rafId, mediaStream }>
  const peers = new Map();
  // mediaStreams: Map<remoteId, MediaStream>  (for recording)
  const mediaStreams = new Map();
  // remoteRecorders: Map<remoteId, MediaRecorder>
  const remoteRecorders = new Map();

  // ===== GLOBAL STUDIO MIXER SETUP =====
  // We use one AudioContext to mix all inbound remote streams.
  let studioAudioContext = null;
  let masterDestination = null; // MediaStreamDestination
  // We will add each remote's incoming stream to this mixer.

  // DOM references:
  const connStatusSpan   = document.getElementById('connStatus');
  const remotesContainer = document.getElementById('remotesContainer');
  const remoteEntryTemplate = document.getElementById('remoteEntryTemplate');

  // Recording controls:
  const recordBtn      = document.getElementById('recordBtn');
  const stopRecordBtn  = document.getElementById('stopRecordBtn');
  const recorderTimerSpan = document.getElementById('recTimer');
  const waveformCanvas = document.getElementById('waveformCanvas');

  let studioRecorder     = null;
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
      // Join as studio
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
      peers.clear();
      mediaStreams.clear();
    };

    ws.onerror = (err) => {
      console.error('[studio] WS error:', err);
      ws.close();
    };
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'new-remote':
        // { type:'new-remote', id, name }
        console.log(`[studio] Remote joined: ${msg.name} (${msg.id})`);
        setupNewRemote(msg.id, msg.name);
        break;

      case 'offer':
        // { type:'offer', from: remoteId, sdp }
        if (peers.has(msg.from)) {
          handleOffer(msg.from, msg.sdp);
        }
        break;

      case 'candidate':
        // { type:'candidate', from: remoteId, candidate }
        if (peers.has(msg.from)) {
          handleCandidate(msg.from, msg.candidate);
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

    const nameEl       = entryEl.querySelector('.remote-name');
    const statusEl     = entryEl.querySelector('.remote-status');
    const callBtn      = entryEl.querySelector('.callRemoteBtn');
    const muteBtn      = entryEl.querySelector('.muteRemoteBtn');
    const kickBtn      = entryEl.querySelector('.kickRemoteBtn');
    const modeSelect   = entryEl.querySelector('.modeSelect');
    const bitrateInput = entryEl.querySelector('.bitrateInput');
    const meterCanvas  = entryEl.querySelector('.remote-meter canvas');
    const jitterCanvas = entryEl.querySelector('.jitter-graph canvas');
    const bitrateCanvas= entryEl.querySelector('.bitrate-graph canvas');
    const chatWindow   = entryEl.querySelector('.chat-window');
    const chatInput    = entryEl.querySelector('.chat-input');
    const chatSendBtn  = entryEl.querySelector('.chat-send-btn');

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
      ws.send(
        JSON.stringify({
          type: 'mode-update',
          target: remoteId,
          mode: modeSelect.value
        })
      );
    };

    bitrateInput.onchange = () => {
      const br = parseInt(bitrateInput.value, 10);
      ws.send(
        JSON.stringify({
          type: 'bitrate-update',
          target: remoteId,
          bitrate: br
        })
      );
    };

    chatSendBtn.onclick = () => {
      const text = chatInput.value.trim();
      if (!text) return;
      ws.send(
        JSON.stringify({
          type: 'chat',
          fromRole: 'studio',
          fromId: 'studio',
          target: 'remote',
          targetId: remoteId,
          text
        })
      );
      appendChatMessage(chatWindow, 'You', text);
      chatInput.value = '';
    };

    // 3) Set up PeerConnection and store placeholders
    const pc = new RTCPeerConnection(ICE_CONFIG);

    // When we get an incoming track from this remote, hook it up
    pc.ontrack = (evt) => {
      const [remoteStream] = evt.streams;
      statusEl.textContent = 'Connected';

      // If we don’t yet have a master mixer context, create it
      if (!studioAudioContext) {
        studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 48000
        });
        masterDestination = studioAudioContext.createMediaStreamDestination();
      }

      // Mix this remote’s stream into the masterDestination
      const srcNode = studioAudioContext.createMediaStreamSource(remoteStream);
      srcNode.connect(masterDestination);

      // Save the remote stream for recording
      mediaStreams.set(remoteId, remoteStream);

      // Prepare per‐remote PPM meter and stats canvases:
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000
      });
      const meterSrc = audioCtx.createMediaStreamSource(remoteStream);
      const splitter = audioCtx.createChannelSplitter(2);

      const analyserL = audioCtx.createAnalyser();
      analyserL.fftSize = 256;
      const analyserR = audioCtx.createAnalyser();
      analyserR.fftSize = 256;

      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      function drawMeter() {
        const bufLen = analyserL.frequencyBinCount;
        const dataL = new Uint8Array(bufLen);
        const dataR = new Uint8Array(bufLen);
        analyserL.getByteFrequencyData(dataL);
        analyserR.getByteFrequencyData(dataR);

        let sumL = 0,
          sumR = 0;
        for (let i = 0; i < bufLen; i++) {
          sumL += dataL[i] * dataL[i];
          sumR += dataR[i] * dataR[i];
        }
        const rmsL = Math.sqrt(sumL / bufLen) / 255;
        const rmsR = Math.sqrt(sumR / bufLen) / 255;

        const ctx = meterCanvas.getContext('2d');
        ctx.clearRect(0, 0, meterCanvas.width, meterCanvas.height);

        const barL = Math.round(rmsL * meterCanvas.width);
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(0, 0, barL, meterCanvas.height / 2 - 2);

        const barR = Math.round(rmsR * meterCanvas.width);
        ctx.fillStyle = '#2196f3';
        ctx.fillRect(0, meterCanvas.height / 2 + 2, barR, meterCanvas.height / 2 - 2);

        dataL.fill(0);
        dataR.fill(0);

        dataL.forEach(() => {});
        dataR.forEach(() => {});

        dataL.fill(0);
        dataR.fill(0);

        dataL.forEach(() => {});
        dataR.forEach(() => {});

        const rafId = requestAnimationFrame(drawMeter);
        peers.get(remoteId).rafId = rafId;
      }

      // Set up the audio context for metering
      meterSrc.connect(splitter);
      drawMeter();

      // Placeholder for jitter & bitrate graphs (just clear them each frame)
      const jitterCtx  = jitterCanvas.getContext('2d');
      const bitrateCtx = bitrateCanvas.getContext('2d');
      function drawStats() {
        jitterCtx.clearRect(0, 0, jitterCanvas.width, jitterCanvas.height);
        bitrateCtx.clearRect(0, 0, bitrateCanvas.width, bitrateCanvas.height);
        requestAnimationFrame(drawStats);
      }
      drawStats();

      // Finally, store details in peers map
      const peerData = peers.get(remoteId);
      if (peerData) {
        peerData.audioContext = audioCtx;
        peerData.analyserL = analyserL;
        peerData.analyserR = analyserR;
        peerData.mediaStream = remoteStream;
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(
          JSON.stringify({
            type: 'candidate',
            from: 'studio',
            target: remoteId,
            candidate: e.candidate
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      statusEl.textContent = `WebRTC: ${state}`;
      if (['disconnected', 'failed', 'closed'].includes(state)) {
        teardownPeer(remoteId);
      }
    };

    // 4) Immediately add the “studio audio” outgoing track (mixed remote audio)
    //    If the masterDestination doesn't exist yet, we’ll create it when the first
    //    remote publishes. For now, we can create an AudioContext/destination so that
    //    once the remote track arrives, it gets mixed automatically.
    if (!studioAudioContext) {
      studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000
      });
      masterDestination = studioAudioContext.createMediaStreamDestination();
    }
    // Add one track from masterDestination to this new pc:
    const [studioTrack] = masterDestination.stream.getAudioTracks();
    if (studioTrack) {
      pc.addTrack(studioTrack, masterDestination.stream);
    }

    // 5) Store the initial peer data:
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
      ws.send(
        JSON.stringify({
          type: 'answer',
          from: 'studio',
          target: remoteId,
          sdp: pc.localDescription.sdp
        })
      );
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
  // 6) RECORDING CONTROLS (Studio)
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

    // Create a fresh AudioContext/destination if not already:
    if (!studioAudioContext) {
      studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000
      });
      masterDestination = studioAudioContext.createMediaStreamDestination();
    }

    // Attach all remote streams to the mixer
    mediaStreams.forEach((stream, remoteId) => {
      const src = studioAudioContext.createMediaStreamSource(stream);
      src.connect(masterDestination);

      // Record each remote individually
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

    // Record the mixed “studio feed”
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
  // INITIALIZE EVERYTHING
  // ────────────────────────────────────────────────────────────────────────
  initWebSocket();
});
