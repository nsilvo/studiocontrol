/**
 * public/js/studio.js
 *
 * Now each HTML file (studio1.html, studio2.html, …) sets `window.STUDIO_ID`
 * before loading this script. We immediately join as that studio without any dropdown.
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Read the global STUDIO_ID that each HTML page injected
  const myStudioId = window.STUDIO_ID || 'UnknownStudio';
  const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;

  // 2. Immediately connect to WebSocket and join as that studio
  const ws = createReconnectingWebSocket(WS_URL);

  // Container for remote cards
  const remotesContainer = document.getElementById('remotes-container');

  // In-memory data structures
  const peers = new Map();           // remoteId → RTCPeerConnection
  const audioElements = new Map();   // remoteId → <audio> element
  const meters = new Map();          // remoteId → { analyser: AnalyserNode, canvas: HTMLElement }
  const statsIntervals = new Map();  // remoteId → interval ID for stats polling
  const mediaRecorders = new Map();  // remoteId → MediaRecorder
  const recordedChunks = new Map();  // remoteId → Array<Blob>

  // When WebSocket opens, send our “join as studio” message
  ws.onOpen = () => {
    console.log(`WebSocket connected. Joining as studio: ${myStudioId}`);
    ws.send(JSON.stringify({ type: 'join', role: 'studio', studioId: myStudioId }));
  };

  ws.onMessage = raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('Invalid JSON:', e);
      return;
    }
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
  };

  ws.onClose = () => {
    console.warn('WebSocket closed. Will attempt reconnect in 2 seconds.');
    setTimeout(() => {
      location.reload(); // Simple way to reconnect
    }, 2000);
  };

  ws.onError = err => {
    console.error('WebSocket error:', err);
    ws.close();
  };

  // ────────────────────────────────────────────────────────────────────────────
  // (A) REMOTE CARD CREATION / DELETION
  // ────────────────────────────────────────────────────────────────────────────

  function addRemoteCard(remoteId, name) {
    const card = document.createElement('div');
    card.className = 'remote-card';
    card.id = `remote-${remoteId}`;

    // Title
    const title = document.createElement('h2');
    title.textContent = `${name} (${remoteId.substring(0, 8)})`;
    card.appendChild(title);

    // Call button
    const callBtn = document.createElement('button');
    callBtn.textContent = 'Call';
    callBtn.onclick = () => {
      ws.send(
        JSON.stringify({
          type: 'ready-for-offer',
          target: remoteId,
          studioId: myStudioId
        })
      );
    };
    card.appendChild(callBtn);

    // Mute button
    const muteBtn = document.createElement('button');
    muteBtn.textContent = 'Mute';
    muteBtn.onclick = () => {
      ws.send(
        JSON.stringify({
          type: 'mute-remote',
          target: remoteId,
          studioId: myStudioId
        })
      );
    };
    card.appendChild(muteBtn);

    // Kick button
    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Kick';
    kickBtn.onclick = () => {
      ws.send(
        JSON.stringify({
          type: 'kick-remote',
          target: remoteId,
          studioId: myStudioId
        })
      );
    };
    card.appendChild(kickBtn);

    // Mode-select (speech/music)
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
      ws.send(
        JSON.stringify({
          type: 'mode-update',
          mode: modeSelect.value,
          target: remoteId,
          studioId: myStudioId
        })
      );
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
      ws.send(
        JSON.stringify({
          type: 'bitrate-update',
          bitrate: br,
          target: remoteId,
          studioId: myStudioId
        })
      );
    };
    bitrateGroup.appendChild(bitrateInput);
    card.appendChild(bitrateGroup);

    // Hidden audio element
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

    // Stats graph canvas
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
      ws.send(
        JSON.stringify({
          type: 'chat',
          fromRole: 'studio',
          fromId: myStudioId,
          target: 'remote',
          targetId: remoteId,
          text
        })
      );
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

    // Upload controls
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

    remotesContainer.appendChild(card);

    meters.set(remoteId, { analyser: null, canvas: meterCanvas });
    statsIntervals.set(remoteId, null);
  }

  function removeRemoteCard(remoteId) {
    const card = document.getElementById(`remote-${remoteId}`);
    if (card) card.remove();

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

  function appendChatMessage(chatBox, sender, text) {
    const msg = document.createElement('div');
    msg.textContent = `[${sender}]: ${text}`;
    chatBox.appendChild(msg);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function receiveChat(fromRole, fromId, text) {
    if (fromRole === 'remote') {
      const chatBox = document.getElementById(`chat-${fromId}`);
      if (chatBox) appendChatMessage(chatBox, fromId, text);
    }
  }

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
          ws.send(
            JSON.stringify({
              type: 'ack-goal',
              targetId: remoteId,
              studioId: myStudioId
            })
          );
          card.style.boxShadow = '';
          ackBtn.remove();
        };
        card.appendChild(ackBtn);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // (B) WEBRTC CALL HANDLING & STATS
  // ────────────────────────────────────────────────────────────────────────────

  function initiateCall(remoteId) {
    ws.send(
      JSON.stringify({
        type: 'ready-for-offer',
        target: remoteId,
        studioId: myStudioId
      })
    );
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
        ws.send(
          JSON.stringify({
            type: 'candidate',
            from: 'studio',
            target: 'remote',
            to: remoteId,
            candidate: event.candidate,
            studioId: myStudioId
          })
        );
      }
    };

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'offer', sdp })
    );
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.send(
      JSON.stringify({
        type: 'answer',
        from: 'studio',
        target: remoteId,
        sdp: pc.localDescription.sdp,
        studioId: myStudioId
      })
    );
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
          if (
            report.type === 'inbound-rtp' &&
            report.mediaType === 'audio'
          ) {
            inboundStats = report;
          }
        });
        if (!inboundStats) return;

        let bitrateKbps = 0;
        if (lastBytesReceived) {
          const bytesDelta =
            inboundStats.bytesReceived - lastBytesReceived;
          bitrateKbps = (bytesDelta * 8) / 1000;
        }
        lastBytesReceived = inboundStats.bytesReceived;

        const jitterMs = inboundStats.jitter * 1000;

        const imageData = ctx.getImageData(1, 0, WIDTH - 1, HEIGHT);
        ctx.putImageData(imageData, 0, 0);
        ctx.clearRect(WIDTH - 1, 0, 1, HEIGHT);

        const jitterY = HEIGHT / 2 - jitterMs / 10;
        const bitrateY = HEIGHT - bitrateKbps / 10;

        ctx.fillStyle = 'red';
        ctx.fillRect(
          WIDTH - 1,
          Math.max(0, Math.min(HEIGHT / 2, jitterY)),
          1,
          1
        );

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

  // ────────────────────────────────────────────────────────────────────────────
  // (C) RECORDING HANDLING
  // ────────────────────────────────────────────────────────────────────────────

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

  // ────────────────────────────────────────────────────────────────────────────
  // Cleanup on page unload
  // ────────────────────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    peers.forEach(pc => pc.close());
    if (ws) ws.close();
  });
});
