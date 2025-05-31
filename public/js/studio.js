/**
 * public/js/studio.js
 *
 * JavaScript logic for the Studio interface, now supporting multiple “studio” identities.
 *
 * 1. Wait for the user to select a studio from a dropdown and click “Join as Studio.”
 * 2. Send { type:"join", role:"studio", studioId:"<chosen‐name>" } to the server.
 * 3. Reveal the “studio-dashboard” and begin handling incoming remotes/offers/etc.
 *
 * Everything else (PPM meters, stats graphs, chat, recording, upload) remains the same.
 */

 // ─────────────────────────────────────────────────────────────────────────────
 // 1) SETUP: Wait for “Join as Studio” click before actually joining
 // ─────────────────────────────────────────────────────────────────────────────

const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
let ws = null;
let myStudioId = null;

// DOM references for the join‐studio panel and the main dashboard:
const studioSelectPanel = document.getElementById('studio-select-panel');
const studioSelect      = document.getElementById('studio-select');
const joinStudioBtn     = document.getElementById('join-studio-btn');
const studioDashboard   = document.getElementById('studio-dashboard');

// Container inside #studio-dashboard where remote cards will appear
const remotesContainer = document.getElementById('remotes-container');

// Data structures to track per‐remote state
const peers = new Map();           // remoteId → RTCPeerConnection
const audioElements = new Map();   // remoteId → <audio> element
const meters = new Map();          // remoteId → { analyser: AnalyserNode, canvas: HTMLElement }
const statsIntervals = new Map();  // remoteId → interval ID for stats polling
const mediaRecorders = new Map();  // remoteId → MediaRecorder
const recordedChunks = new Map();  // remoteId → Array<Blob>

// Only start WebSocket/remote‐handling once “Join as Studio” is clicked:
joinStudioBtn.addEventListener('click', () => {
  const selected = studioSelect.value;
  if (!selected) {
    alert('Please select a studio name before joining.');
    return;
  }
  myStudioId = selected;
  initializeWebSocketAsStudio(myStudioId);

  // Hide the “select studio” panel, reveal the dashboard
  studioSelectPanel.classList.add('hidden');
  studioDashboard.classList.remove('hidden');
});


 // ─────────────────────────────────────────────────────────────────────────────
 // 2) INITIALIZE WEBSOCKET ONCE we have a studioId
 // ─────────────────────────────────────────────────────────────────────────────

function initializeWebSocketAsStudio(studioId) {
  ws = createReconnectingWebSocket(WS_URL);

  ws.onMessage(msg => {
    switch (msg.type) {
      case 'new-remote':
        addRemoteCard(msg.id, msg.name);
        break;

      case 'offer':
        handleOffer(msg.from, msg.sdp);
        break;

      case 'candidate':
        handleCandidate(msg.from, msg.candidate);
        break;

      case 'chat':
        receiveChat(msg.fromRole, msg.fromId, msg.text);
        break;

      case 'remote-disconnected':
        removeRemoteCard(msg.id);
        break;

      case 'goal':
        handleGoalNotification(msg.fromId, msg.team);
        break;

      default:
        console.warn('Studio received unknown message:', msg);
    }
  });

  // Once WebSocket connects, send our “join” with the chosen studioId
  ws.onOpen = () => {
    console.log(`WebSocket connected. Joining as studio: ${studioId}`);
    ws.send({ type: 'join', role: 'studio', studioId: studioId });
  };

  ws.onClose = () => {
    console.warn('WebSocket closed. Attempting reconnect in 2 seconds...');
    setTimeout(() => {
      initializeWebSocketAsStudio(studioId);
    }, 2000);
  };

  ws.onError = err => {
    console.error('WebSocket error:', err);
    ws.close();
  };
}


 // ─────────────────────────────────────────────────────────────────────────────
 // 3) ADD & REMOVE “REMOTE CARDS” (one per connected remote)
 // ─────────────────────────────────────────────────────────────────────────────

function addRemoteCard(remoteId, name) {
  // Outer card <div id="remote-<remoteId>" class="remote-card">
  const card = document.createElement('div');
  card.className = 'remote-card';
  card.id = `remote-${remoteId}`;

  // Title with remote’s display name
  const title = document.createElement('h2');
  title.textContent = `${name} (${ remoteId.substring(0,8) })`;
  card.appendChild(title);

  // “Call” button
  const callBtn = document.createElement('button');
  callBtn.textContent = 'Call';
  callBtn.onclick = () => {
    ws.send({ type: 'ready-for-offer', target: remoteId, studioId: myStudioId });
  };
  card.appendChild(callBtn);

  // “Mute” button
  const muteBtn = document.createElement('button');
  muteBtn.textContent = 'Mute';
  muteBtn.onclick = () => {
    ws.send({ type: 'mute-remote', target: remoteId, studioId: myStudioId });
  };
  card.appendChild(muteBtn);

  // “Kick” button
  const kickBtn = document.createElement('button');
  kickBtn.textContent = 'Kick';
  kickBtn.onclick = () => {
    ws.send({ type: 'kick-remote', target: remoteId, studioId: myStudioId });
  };
  card.appendChild(kickBtn);

  // Mode‐select dropdown (Speech vs. Music)
  const modeGroup = document.createElement('div');
  modeGroup.className = 'control-group';
  const modeLabel = document.createElement('label');
  modeLabel.textContent = 'Mode:';
  modeGroup.appendChild(modeLabel);
  const modeSelect = document.createElement('select');
  ['speech','music'].forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m.charAt(0).toUpperCase() + m.slice(1);
    modeSelect.appendChild(opt);
  });
  modeSelect.onchange = () => {
    ws.send({
      type: 'mode-update',
      mode: modeSelect.value,
      target: remoteId,
      studioId: myStudioId
    });
  };
  modeGroup.appendChild(modeSelect);
  card.appendChild(modeGroup);

  // Bitrate input (number)
  const bitrateGroup = document.createElement('div');
  bitrateGroup.className = 'control-group';
  const bitrateLabel = document.createElement('label');
  bitrateLabel.textContent = 'Bitrate:';
  bitrateGroup.appendChild(bitrateLabel);
  const bitrateInput = document.createElement('input');
  bitrateInput.type = 'number';
  bitrateInput.min = 1000;
  bitrateInput.max = 64000;
  bitrateInput.value = 16000;
  bitrateInput.onchange = () => {
    const br = parseInt(bitrateInput.value);
    ws.send({
      type: 'bitrate-update',
      bitrate: br,
      target: remoteId,
      studioId: myStudioId
    });
  };
  bitrateGroup.appendChild(bitrateInput);
  card.appendChild(bitrateGroup);

  // Hidden <audio> tag for the actual remote‐audio stream
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.controls = false;
  audioEl.style.display = 'none';
  card.appendChild(audioEl);
  audioElements.set(remoteId, audioEl);

  // PPM meter canvas (mono → display left+right the same if remote is mono)
  const meterCanvas = document.createElement('canvas');
  meterCanvas.width = 300;
  meterCanvas.height = 50;
  meterCanvas.className = 'meter-canvas';
  card.appendChild(meterCanvas);

  // Jitter & bitrate stats graph canvas
  const statsCanvas = document.createElement('canvas');
  statsCanvas.width = 300;
  statsCanvas.height = 50;
  statsCanvas.className = 'stats-canvas';
  card.appendChild(statsCanvas);

  // Chat interface for this remote
  const chatContainer = document.createElement('div');
  chatContainer.className = 'chat-container';
  const chatMsgBox = document.createElement('div');
  chatMsgBox.className = 'chat-messages';
  chatMsgBox.id = `chat-${remoteId}`;
  chatContainer.appendChild(chatMsgBox);
  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.className = 'chat-input';
  chatInput.placeholder = 'Type message...';
  chatContainer.appendChild(chatInput);
  const chatSendBtn = document.createElement('button');
  chatSendBtn.textContent = 'Send';
  chatSendBtn.className = 'chat-send-btn';
  chatSendBtn.onclick = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    ws.send({
      type: 'chat',
      fromRole: 'studio',
      fromId: myStudioId,
      target: 'remote',
      targetId: remoteId,
      text
    });
    appendChatMessage(chatMsgBox, 'You', text);
    chatInput.value = '';
  };
  chatContainer.appendChild(chatSendBtn);
  card.appendChild(chatContainer);

  // Recording controls (Start/Stop)
  const recContainer = document.createElement('div');
  recContainer.className = 'recording-controls';
  const recStartBtn = document.createElement('button');
  recStartBtn.textContent = 'Start Recording';
  recStartBtn.onclick = () => startRecording(remoteId);
  recContainer.appendChild(recStartBtn);
  const recStopBtn = document.createElement('button');
  recStopBtn.textContent = 'Stop Recording';
  recStopBtn.onclick = () => stopRecording(remoteId);
  recContainer.appendChild(recStopBtn);
  card.appendChild(recContainer);

  // File‐upload controls
  const uploadContainer = document.createElement('div');
  uploadContainer.className = 'upload-container';
  const uploadLabel = document.createElement('label');
  uploadLabel.textContent = 'Upload Files:';
  uploadContainer.appendChild(uploadLabel);
  const uploadInput = document.createElement('input');
  uploadInput.type = 'file';
  uploadInput.multiple = true;
  uploadContainer.appendChild(uploadInput);
  const uploadBtn = document.createElement('button');
  uploadBtn.textContent = 'Upload';
  uploadBtn.onclick = () => {
    const files = uploadInput.files;
    if (files.length === 0) return alert('Select files to upload.');
    const formData = new FormData();
    for (let f of files) {
      formData.append('files', f);
    }
    fetch('/upload', { method: 'POST', body: formData })
      .then(res => res.json())
      .then(json => {
        alert('Uploaded: ' + json.uploaded.join(', '));
      })
      .catch(err => console.error('Upload error:', err));
  };
  uploadContainer.appendChild(uploadBtn);
  card.appendChild(uploadContainer);

  // Finally, append to the remotes container
  remotesContainer.appendChild(card);

  // Initialize placeholders for PPM analyser and stats
  meters.set(remoteId, { analyser: null, canvas: meterCanvas });
  statsIntervals.set(remoteId, null);
}

function removeRemoteCard(remoteId) {
  const card = document.getElementById(`remote-${remoteId}`);
  if (card) card.remove();

  // Clean up any associated resources
  if (peers.has(remoteId)) {
    peers.get(remoteId).close();
    peers.delete(remoteId);
  }
  if (statsIntervals.has(remoteId)) {
    clearInterval(statsIntervals.get(remoteId));
    statsIntervals.delete(remoteId);
  }
  if (audioElements.has(remoteId)) audioElements.get(remoteId).remove();
  if (meters.has(remoteId)) meters.delete(remoteId);
  if (mediaRecorders.has(remoteId)) mediaRecorders.delete(remoteId);
  if (recordedChunks.has(remoteId)) recordedChunks.delete(remoteId);
}

// Append a chat message into the appropriate chat box
function appendChatMessage(chatBox, sender, text) {
  const msg = document.createElement('div');
  msg.textContent = `[${sender}]: ${text}`;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Handle incoming chat (to the studio)
function receiveChat(fromRole, fromId, text) {
  if (fromRole === 'remote') {
    const chatBox = document.getElementById(`chat-${fromId}`);
    if (chatBox) appendChatMessage(chatBox, fromId, text);
  }
}

// Handle a “goal” notification from a sports remote
function handleGoalNotification(remoteId, team) {
  alert(`⚽ Goal by ${team} from remote ${remoteId.substring(0, 8)}!`);
  const card = document.getElementById(`remote-${remoteId}`);
  if (card) {
    card.style.boxShadow = '0 0 10px 3px gold';
    let ackBtn = card.querySelector('.ack-goal-btn');
    if (!ackBtn) {
      ackBtn = document.createElement('button');
      ackBtn.textContent = 'Acknowledge Goal';
      ackBtn.className = 'ack-goal-btn';
      ackBtn.onclick = () => {
        ws.send({ type: 'ack-goal', targetId: remoteId, studioId: myStudioId });
        card.style.boxShadow = '';
        ackBtn.remove();
      };
      card.appendChild(ackBtn);
    }
  }
}


 // ─────────────────────────────────────────────────────────────────────────────
 // 4) WEBRTC CALL HANDLING & STATS
 // ─────────────────────────────────────────────────────────────────────────────

function initiateCall(remoteId) {
  // Tell server: “Studio <myStudioId> wants to initiate a call with <remoteId>”
  ws.send({ type: 'ready-for-offer', target: remoteId, studioId: myStudioId });
}

async function handleOffer(remoteId, sdp) {
  const pc = new RTCPeerConnection(getRTCConfig());
  peers.set(remoteId, pc);

  pc.ontrack = event => {
    const [stream] = event.streams;
    const audioEl = audioElements.get(remoteId);
    audioEl.srcObject = stream;
    audioEl.style.display = 'block';

    const audioCtx = new AudioContext();
    const sourceNode = audioCtx.createMediaStreamSource(stream);
    const meterInfo = meters.get(remoteId);
    meterInfo.analyser = createPPMMeter(audioCtx, sourceNode, meterInfo.canvas);

    const statsCanvas = meterInfo.canvas.nextElementSibling;
    startRTCPeerStats(pc, statsCanvas, remoteId);
  };

  pc.onicecandidate = event => {
    if (event.candidate) {
      ws.send({
        type: 'candidate',
        from: 'studio',
        target: 'remote',
        to: remoteId,
        candidate: event.candidate,
        studioId: myStudioId
      });
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send({
    type: 'answer',
    from: 'studio',
    target: remoteId,
    sdp: pc.localDescription.sdp,
    studioId: myStudioId
  });
}

async function handleCandidate(remoteId, candidate) {
  const pc = peers.get(remoteId);
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Error adding ICE candidate:', e);
    }
  }
}

// Collect and plot jitter & bitrate stats for a peer connection
function startRTCPeerStats(pc, canvas, remoteId) {
  const ctx = canvas.getContext('2d');
  const WIDTH = canvas.width;
  const HEIGHT = canvas.height;
  let lastBytesReceived = 0;

  function drawFrame() {
    pc.getStats(null).then(stats => {
      let inboundStats;
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
          inboundStats = report;
        }
      });
      if (!inboundStats) return;

      // Calculate bitrate in kbps
      let bitrateKbps = 0;
      if (lastBytesReceived) {
        const bytesDelta = inboundStats.bytesReceived - lastBytesReceived;
        bitrateKbps = (bytesDelta * 8) / 1000;
      }
      lastBytesReceived = inboundStats.bytesReceived;

      // Jitter in ms
      const jitterMs = inboundStats.jitter * 1000;

      // Shift canvas left by 1px
      const imageData = ctx.getImageData(1, 0, WIDTH - 1, HEIGHT);
      ctx.putImageData(imageData, 0, 0);
      ctx.clearRect(WIDTH - 1, 0, 1, HEIGHT);

      // Map jitter & bitrate to vertical coordinates
      const jitterY = HEIGHT / 2 - (jitterMs / 10);      // scale jitter
      const bitrateY = HEIGHT - (bitrateKbps / 10);      // scale bitrate

      // Draw jitter (red) in top half
      ctx.fillStyle = 'red';
      ctx.fillRect(
        WIDTH - 1,
        Math.max(0, Math.min(HEIGHT / 2, jitterY)),
        1,
        1
      );

      // Draw bitrate (lime) in bottom half
      ctx.fillStyle = 'lime';
      ctx.fillRect(
        WIDTH - 1,
        Math.max(HEIGHT / 2, Math.min(HEIGHT - 1, bitrateY)),
        1,
        1
      );
    });
  }

  const intervalId = setInterval(drawFrame, 1000);
  statsIntervals.set(remoteId, intervalId);
}


 // ─────────────────────────────────────────────────────────────────────────────
 // 5) RECORDING HANDLING
 // ─────────────────────────────────────────────────────────────────────────────

function startRecording(remoteId) {
  const audioEl = audioElements.get(remoteId);
  if (!audioEl || !audioEl.srcObject) {
    alert('No audio stream to record.');
    return;
  }
  const stream = audioEl.srcObject;
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  const chunks = [];
  recorder.ondataavailable = e => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const filename = `remote-${remoteId}-${Date.now()}.webm`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);
    recordedChunks.set(remoteId, chunks.slice());
  };
  recorder.start();
  mediaRecorders.set(remoteId, recorder);
  alert('Recording started.');
}

function stopRecording(remoteId) {
  const recorder = mediaRecorders.get(remoteId);
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
    alert('Recording stopped and download link created.');
  }
}


 // ─────────────────────────────────────────────────────────────────────────────
 // 6) CLEANUP ON UNLOAD
 // ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  peers.forEach(pc => pc.close());
  if (ws) ws.close();
});
