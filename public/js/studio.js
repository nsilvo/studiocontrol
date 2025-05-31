/**
 * public/js/studio.js
 * 
 * JavaScript logic for the Studio interface.
 * Handles:
 *  - WebSocket signaling (join as studio, receive new-remotes, offers, candidates, chat, goals)
 *  - For each remote: initiate call, handle incoming audio track
 *  - PPM meter, jitter & bitrate graphs, chat, recording, upload
 */

const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
const ws = createReconnectingWebSocket(WS_URL);

const remotesContainer = document.getElementById('remotes-container');
const recordingsDir = '/recordings'; // Base path where recordings are served

// Data structures to track per-remote state
const peers = new Map();         // remoteId → RTCPeerConnection
const audioElements = new Map(); // remoteId → <audio> DOM element
const meters = new Map();        // remoteId → { analyser, canvas } for PPM
const statsIntervals = new Map();// remoteId → interval ID for stats polling
const mediaRecorders = new Map();// remoteId → MediaRecorder
const recordedChunks = new Map();// remoteId → Array of Blobs

// Upon opening WebSocket, join as studio
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

ws.send({ type: 'join', role: 'studio' });

// --- UI Helpers ---

function addRemoteCard(remoteId, name) {
  const card = document.createElement('div');
  card.className = 'remote-card';
  card.id = `remote-${remoteId}`;

  const title = document.createElement('h2');
  title.textContent = `${name} (${remoteId.substring(0, 8)})`;
  card.appendChild(title);

  // Call button
  const callBtn = document.createElement('button');
  callBtn.textContent = 'Call';
  callBtn.onclick = () => initiateCall(remoteId);
  card.appendChild(callBtn);

  // Mute button
  const muteBtn = document.createElement('button');
  muteBtn.textContent = 'Mute';
  muteBtn.onclick = () => {
    ws.send({ type: 'mute-remote', target: remoteId });
  };
  card.appendChild(muteBtn);

  // Kick button
  const kickBtn = document.createElement('button');
  kickBtn.textContent = 'Kick';
  kickBtn.onclick = () => {
    ws.send({ type: 'kick-remote', target: remoteId });
  };
  card.appendChild(kickBtn);

  // Mode selector
  const modeGroup = document.createElement('div');
  modeGroup.className = 'control-group';
  const modeLabel = document.createElement('label');
  modeLabel.textContent = 'Mode:';
  modeGroup.appendChild(modeLabel);
  const modeSelect = document.createElement('select');
  ['speech', 'music'].forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m.charAt(0).toUpperCase() + m.slice(1);
    modeSelect.appendChild(opt);
  });
  modeSelect.onchange = () => {
    ws.send({ type: 'mode-update', mode: modeSelect.value, target: remoteId });
  };
  modeGroup.appendChild(modeSelect);
  card.appendChild(modeGroup);

  // Bitrate input
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
    ws.send({ type: 'bitrate-update', bitrate: br, target: remoteId });
  };
  bitrateGroup.appendChild(bitrateInput);
  card.appendChild(bitrateGroup);

  // Hidden audio element for remote stream
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.controls = false;
  audioEl.style.display = 'none';
  card.appendChild(audioEl);
  audioElements.set(remoteId, audioEl);

  // PPM meter canvas
  const meterCanvas = document.createElement('canvas');
  meterCanvas.width = 300;
  meterCanvas.height = 50;
  meterCanvas.className = 'meter-canvas';
  card.appendChild(meterCanvas);

  // Stats graph canvas (jitter & bitrate)
  const statsCanvas = document.createElement('canvas');
  statsCanvas.width = 300;
  statsCanvas.height = 50;
  statsCanvas.className = 'stats-canvas';
  card.appendChild(statsCanvas);

  // Chat UI
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
      fromId: 'studio',
      target: 'remote',
      targetId: remoteId,
      text
    });
    appendChatMessage(chatMsgBox, 'You', text);
    chatInput.value = '';
  };
  chatContainer.appendChild(chatSendBtn);
  card.appendChild(chatContainer);

  // Recording controls
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

  // Upload container
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

  // Append card to container
  remotesContainer.appendChild(card);

  // Store PPM canvas reference
  meters.set(remoteId, { analyser: null, canvas: meterCanvas });
  statsIntervals.set(remoteId, null);
}

function removeRemoteCard(remoteId) {
  const card = document.getElementById(`remote-${remoteId}`);
  if (card) card.remove();
  // Clean up peer, recorder, etc.
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

// Append a chat message to a given chat box
function appendChatMessage(chatBox, sender, text) {
  const msg = document.createElement('div');
  msg.textContent = `[${sender}]: ${text}`;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Handle incoming chat (to studio)
function receiveChat(fromRole, fromId, text) {
  if (fromRole === 'remote') {
    const chatBox = document.getElementById(`chat-${fromId}`);
    if (chatBox) appendChatMessage(chatBox, fromId, text);
  }
}

// Handle goal notifications from sports remotes
function handleGoalNotification(remoteId, team) {
  alert(`⚽ Goal by ${team} from remote ${remoteId.substring(0,8)}!`);
  const card = document.getElementById(`remote-${remoteId}`);
  if (card) {
    card.style.boxShadow = '0 0 10px 3px gold';
    let ackBtn = card.querySelector('.ack-goal-btn');
    if (!ackBtn) {
      ackBtn = document.createElement('button');
      ackBtn.textContent = 'Acknowledge Goal';
      ackBtn.className = 'ack-goal-btn';
      ackBtn.onclick = () => {
        ws.send({ type: 'ack-goal', targetId: remoteId });
        card.style.boxShadow = '';
        ackBtn.remove();
      };
      card.appendChild(ackBtn);
    }
  }
}

// --- WebRTC Call Handling ---

function initiateCall(remoteId) {
  ws.send({ type: 'ready-for-offer', target: remoteId });
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
        candidate: event.candidate
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
    sdp: pc.localDescription.sdp
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

      let bitrateKbps = 0;
      if (lastBytesReceived) {
        const bytesDelta = inboundStats.bytesReceived - lastBytesReceived;
        bitrateKbps = (bytesDelta * 8) / 1000;
      }
      lastBytesReceived = inboundStats.bytesReceived;

      const jitterMs = inboundStats.jitter * 1000;

      const imageData = ctx.getImageData(1, 0, WIDTH - 1, HEIGHT);
      ctx.putImageData(imageData, 0, 0);
      ctx.clearRect(WIDTH - 1, 0, 1, HEIGHT);

      const jitterY = HEIGHT / 2 - (jitterMs / 10);
      const bitrateY = HEIGHT - (bitrateKbps / 10);

      ctx.fillStyle = 'red';
      ctx.fillRect(WIDTH - 1, Math.max(0, Math.min(HEIGHT / 2, jitterY)), 1, 1);

      ctx.fillStyle = 'lime';
      ctx.fillRect(WIDTH - 1, Math.max(HEIGHT / 2, Math.min(HEIGHT - 1, bitrateY)), 1, 1);
    });
  }

  const intervalId = setInterval(drawFrame, 1000);
  statsIntervals.set(remoteId, intervalId);
}

// --- Recording Handling ---

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

// Release resources when leaving page
window.addEventListener('beforeunload', () => {
  peers.forEach(pc => pc.close());
  ws.close();
});
