/**
 * public/js/studio.js
 *
 * - Manages WebSocket signaling and RTCPeerConnections for multiple remotes.
 * - Captures the studio mic and adds that track to every remote’s PC → remotes hear studio.
 * - Each remote‐entry now has an <audio> element so the studio hears the remote.
 * - Implements global/studio chat and per‐remote chat.
 * - Multi‐track recording: captures each remote’s audio + mixed studio feed → uploads to /upload.
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
  // mediaStreams: Map<remoteId, MediaStream>  (for per‐remote recording)
  const mediaStreams = new Map();
  // remoteRecorders: Map<remoteId, MediaRecorder>
  const remoteRecorders = new Map();

  // ===== STUDIO MIC & MIXER SETUP =====
  // 1) We capture studio mic once (stereo or mono as is).
  // 2) Whenever a new remote PC is created, we add that mic track to it so remotes hear us.
  // 3) We also mix incoming remote streams into a master destination so we can record them.
  let studioMicStream = null;            // MediaStream from getUserMedia({audio:true})
  let studioAudioContext = null;         // AudioContext for mixing incoming remote streams
  let masterDestination = null;          // MediaStreamDestination for recording the “studio mix”

  // ===== DOM REFERENCES =====
  const connStatusSpan     = document.getElementById('connStatus');
  const remotesContainer   = document.getElementById('remotesContainer');
  const remoteEntryTemplate= document.getElementById('remoteEntryTemplate');

  // Global Chat Elements
  const chatWindowAll      = document.getElementById('chatWindow');
  const chatInputAll       = document.getElementById('chatInput');
  const chatSendBtnAll     = document.getElementById('sendChatBtn');

  // Recording Controls
  const recordBtn          = document.getElementById('recordBtn');
  const stopRecordBtn      = document.getElementById('stopRecordBtn');
  const recorderTimerSpan  = document.getElementById('recTimer');
  const waveformCanvas     = document.getElementById('waveformCanvas');

  let studioRecorder       = null;
  let recordingStartTime   = null;
  let recorderTimerInterval= null;

  // ===================================================================
  // 1) INITIALIZE STUDIO MIC
  // ===================================================================
  // Request microphone access immediately, so we can add the mic track to every PC.
  async function initStudioMic() {
    try {
      studioMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[studio] Studio mic stream acquired');
    } catch (err) {
      console.error('[studio] Error accessing microphone:', err);
      alert('Microphone access is required for the studio to send audio to remotes.');
    }
  }

  // ===================================================================
  // 2) GLOBAL CHAT HELPERS
  // ===================================================================
  function appendGlobalChatMessage(sender, text) {
    const div = document.createElement('div');
    div.textContent = `[${sender}]: ${text}`;
    chatWindowAll.appendChild(div);
    chatWindowAll.scrollTop = chatWindowAll.scrollHeight;
  }

  chatSendBtnAll.onclick = () => {
    const text = chatInputAll.value.trim();
    if (!text) return;
    // Send to server; server will broadcast to all studios/remotes
    ws.send(
      JSON.stringify({
        type: 'chat',
        fromRole: 'studio',
        fromId: window.STUDIO_ID || 'Studio',
        text,
        target: 'all'
      })
    );
    appendGlobalChatMessage('You', text);
    chatInputAll.value = '';
  };

  // ===================================================================
  // 3) INITIALIZE WEBSOCKET
  // ===================================================================
  function initWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[studio] WS opened');
      connStatusSpan.textContent = 'WS connected';
      // Join as studio (include the ID so server tags chat/logs properly)
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'studio',
          studioId: window.STUDIO_ID || 'Studio'
        })
      );
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
        // Only add candidate if PC exists && remoteDescription is set
        if (peers.has(msg.from) && peers.get(msg.from).pc.remoteDescription) {
          handleCandidate(msg.from, msg.candidate);
        }
        break;

      case 'remote-disconnected':
        // { type:'remote-disconnected', id }
        console.log(`[studio] Remote disconnected: ${msg.id}`);
        teardownPeer(msg.id);
        break;

      case 'chat':
        // { type:'chat', fromRole:'remote'|'studio', fromId, text }
        appendGlobalChatMessage(msg.fromId || 'Anonymous', msg.text);
        break;

      default:
        console.warn('[studio] Unknown message:', msg.type);
    }
  }

  // ===================================================================
  // 4) SET UP A NEW REMOTE ENTRY
  // ===================================================================
  function setupNewRemote(remoteId, remoteName) {
    // 1) Clone the template
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
    const audioEl      = entryEl.querySelector('.remote-audio');
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
        fromId: window.STUDIO_ID || 'Studio',
        target: 'remote',
        targetId: remoteId,
        text
      }));
      appendPerRemoteChatMessage(chatWindow, 'You', text);
      chatInput.value = '';
    };

    // 3) Create PeerConnection and store placeholders
    const pc = new RTCPeerConnection(ICE_CONFIG);

    // 3a) If we already have the studio mic, immediately add it so remote hears us
    if (studioMicStream) {
      studioMicStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, studioMicStream);
      });
    }

    // 3b) When we get a track from this remote, wire it into the <audio> element & mixer
    pc.ontrack = (evt) => {
      const [remoteStream] = evt.streams;
      statusEl.textContent = 'Connected';

      // 3b-i) Send remote audio into the <audio> so studio can hear them
      if (audioEl.srcObject !== remoteStream) {
        audioEl.srcObject = remoteStream;
      }

      // 3b-ii) Set up the master mixer if not yet done
      if (!studioAudioContext) {
        studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        masterDestination = studioAudioContext.createMediaStreamDestination();
      }

      // 3b-iii) Mix this remote’s stream into masterDestination for recording
      const srcNode = studioAudioContext.createMediaStreamSource(remoteStream);
      srcNode.connect(masterDestination);

      // 3b-iv) Save for per‐remote recording
      mediaStreams.set(remoteId, remoteStream);

      // 3b-v) Set up per‐remote PPM meter
      const meterAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const meterSrc = meterAudioCtx.createMediaStreamSource(remoteStream);
      const splitter = meterAudioCtx.createChannelSplitter(2);

      const analyserL = meterAudioCtx.createAnalyser();
      analyserL.fftSize = 256;
      const analyserR = meterAudioCtx.createAnalyser();
      analyserR.fftSize = 256;

      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

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

        const ctx = meterCanvas.getContext('2d');
        ctx.clearRect(0, 0, meterCanvas.width, meterCanvas.height);

        const barL = Math.round(rmsL * meterCanvas.width);
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(0, 0, barL, meterCanvas.height / 2 - 2);

        const barR = Math.round(rmsR * meterCanvas.width);
        ctx.fillStyle = '#2196f3';
        ctx.fillRect(0, meterCanvas.height / 2 + 2, barR, meterCanvas.height / 2 - 2);

        const rafId = requestAnimationFrame(drawMeter);
        peers.get(remoteId).rafId = rafId;
      }

      meterSrc.connect(splitter);
      drawMeter();

      // 3b-vi) Placeholder “jitter” & “bitrate” canvases (clear each frame)
      const jitterCtx  = jitterCanvas.getContext('2d');
      const bitrateCtx = bitrateCanvas.getContext('2d');
      function drawStats() {
        jitterCtx.clearRect(0, 0, jitterCanvas.width, jitterCanvas.height);
        bitrateCtx.clearRect(0, 0, bitrateCanvas.width, bitrateCanvas.height);
        requestAnimationFrame(drawStats);
      }
      drawStats();

      // 3b-vii) Update stored peer data
      const peerData = peers.get(remoteId);
      if (peerData) {
        peerData.audioContext = meterAudioCtx;
        peerData.analyserL   = analyserL;
        peerData.analyserR   = analyserR;
        peerData.mediaStream = remoteStream;
      }
    };

    // 3c) ICE candidate handler
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

    // 3d) Connection state change
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      statusEl.textContent = `WebRTC: ${state}`;
      if (['disconnected', 'failed', 'closed'].includes(state)) {
        teardownPeer(remoteId);
      }
    };

    // 4) Store peer data in the map
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

  // ===================================================================
  // 5) HANDLE INCOMING OFFER FROM REMOTE
  // ===================================================================
  async function handleOffer(remoteId, sdp) {
    const data = peers.get(remoteId);
    if (!data) return;
    const pc = data.pc;
    try {
      // 5a) Set remote description (the offer from the remote)
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

      // 5b) Now that studio has the remote’s offer, our mic track is already added (see setupNewRemote).
      //      Create an answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // 5c) Send that answer back to the remote
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

  // ===================================================================
  // 6) HANDLE INCOMING ICE CANDIDATE
  // ===================================================================
  async function handleCandidate(remoteId, candidate) {
    const data = peers.get(remoteId);
    if (!data || !data.pc.remoteDescription) {
      // If no PC or remoteDescription yet, skip
      return;
    }
    try {
      await data.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error(`[studio] addIceCandidate error for ${remoteId}:`, e);
    }
  }

  // ===================================================================
  // 7) TEARDOWN A REMOTE
  // ===================================================================
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

  // ===================================================================
  // 8) RECORDING CONTROLS
  // ===================================================================
  recordBtn.onclick = () => startRecording();
  stopRecordBtn.onclick = () => stopRecording();

  function startRecording() {
    if (mediaStreams.size === 0) {
      alert('No remotes connected.');
      return;
    }

    recordBtn.disabled = true;
    stopRecordBtn.disabled = false;

    // Create master mixer if not yet created
    if (!studioAudioContext) {
      studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      masterDestination = studioAudioContext.createMediaStreamDestination();
    }

    // Attach each remote’s incoming stream to the mixer
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

    // Record the mixed “studio feed” (all remotes combined)
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

  // ===================================================================
  // 9) PER-REMOTE CHAT HELPER
  // ===================================================================
  function appendPerRemoteChatMessage(container, sender, text) {
    const div = document.createElement('div');
    div.textContent = `[${sender}]: ${text}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ===================================================================
  // 10) INITIALIZATION
  // ===================================================================
  (async () => {
    await initStudioMic();
    initWebSocket();
  })();
});
