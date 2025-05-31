/**
 * studio.js (complete)
 *
 * - Manages WebSocket signaling, PeerConnections for multiple remotes.
 * - For each connected remote:
 *   • Inserts a `.remote-entry` into #remotesContainer.
 *   • Creates an AudioContext + two AnalyserNodes to meter left/right channels.
 *   • Draws those meters onto that remote’s <canvas>.
 *   • Provides “Mute” & “Kick” buttons.
 * - Implements multi‐track recording (studio mix + each remote) with waveform display & timer.
 * - When recording stops, uploads all recorded blobs to the server at /upload.
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

  let ws = null;
  // peers maps peerId → { pc, entryEl, audioContext, analyserL, analyserR, rafId, mediaStream }
  const peers = new Map();

  // DOM references
  const connStatusSpan = document.getElementById('connStatus');
  const remotesContainer = document.getElementById('remotesContainer');
  const remoteEntryTemplate = document.getElementById('remoteEntryTemplate');

  // Recording controls (create these in HTML or add here dynamically)
  let recordBtn, stopRecordBtn, recorderTimerSpan, waveformCanvas;
  let studioAudioContext, studioMixedStream, studioRecorder;
  let remoteRecorders = new Map(); // remoteId → MediaRecorder
  let mediaStreamsToRecord = new Map(); // remoteId → MediaStream
  let recordingStartTime = null;
  let recorderTimerInterval = null;

  /////////////////////////////////////////////////////
  // Initialize WebSocket
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('WebSocket connected (studio).');
      connStatusSpan.textContent = 'connected (WS)';
      // Announce self as studio
      ws.send(JSON.stringify({ type: 'join', role: 'studio' }));
    };
    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (err) {
        console.error('Invalid JSON from WS:', err);
        return;
      }
      handleSignalingMessage(msg);
    };
    ws.onclose = () => {
      console.warn('WebSocket closed. Retrying in 5 seconds...');
      connStatusSpan.textContent = 'disconnected (WS)';
      setTimeout(initWebSocket, 5000);
      // Clean up all existing peers
      for (let peerId of peers.keys()) {
        teardownPeer(peerId);
      }
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
      case 'new-remote':
        // { type:'new-remote', id, name }
        console.log(`Remote joined: ${msg.name} (${msg.id})`);
        await setupNewRemote(msg.id, msg.name);
        break;

      case 'offer':
        // { type:'offer', from:remoteId, sdp }
        if (peers.has(msg.from)) {
          await handleOffer(msg.from, msg.sdp);
        }
        break;

      case 'candidate':
        // { type:'candidate', from:remoteId, candidate }
        if (peers.has(msg.from)) {
          await handleCandidate(msg.from, msg.candidate);
        }
        break;

      case 'remote-disconnected':
        // { type:'remote-disconnected', id }
        console.log(`Remote disconnected: ${msg.id}`);
        teardownPeer(msg.id);
        break;

      default:
        console.warn('Unknown WS message (studio):', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Set up a new PeerConnection for a remote
  /////////////////////////////////////////////////////
  async function setupNewRemote(remoteId, remoteName) {
    // 1) Create UI entry from template
    const clone = remoteEntryTemplate.content.cloneNode(true);
    const entryEl = clone.querySelector('.remote-entry');
    entryEl.id = `remote-${remoteId}`;

    const nameEl = entryEl.querySelector('.remote-name');
    const statusEl = entryEl.querySelector('.remote-status');
    const muteBtn = entryEl.querySelector('.muteRemoteBtn');
    const kickBtn = entryEl.querySelector('.kickRemoteBtn');
    const canvas = entryEl.querySelector('canvas');

    nameEl.textContent = remoteName;
    statusEl.textContent = 'Connecting…';

    remotesContainer.appendChild(entryEl);

    // 2) Attach button handlers
    muteBtn.onclick = () => {
      ws.send(JSON.stringify({ type: 'mute-remote', target: remoteId }));
      muteBtn.textContent = 'Muted';
      muteBtn.disabled = true;
    };
    kickBtn.onclick = () => {
      ws.send(JSON.stringify({ type: 'kick-remote', target: remoteId }));
      kickBtn.disabled = true;
    };

    // 3) Set up RTCPeerConnection
    const pc = new RTCPeerConnection(ICE_CONFIG);

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        ws.send(
          JSON.stringify({
            type: 'candidate',
            from: 'studio',
            target: remoteId,
            candidate: evt.candidate,
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      statusEl.textContent = `WebRTC: ${state}`;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        teardownPeer(remoteId);
      }
    };

    pc.ontrack = (evt) => {
      // We expect a single audio stream per remote
      const [remoteStream] = evt.streams;
      statusEl.textContent = 'Connected';

      // Store the remote’s stream for recording
      mediaStreamsToRecord.set(remoteId, remoteStream);

      // Create an AudioContext + AnalyserNodes for this remote
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000,
      });
      const sourceNode = audioContext.createMediaStreamSource(remoteStream);
      const splitter = audioContext.createChannelSplitter(2);

      const analyserL = audioContext.createAnalyser();
      analyserL.fftSize = 256;
      const analyserR = audioContext.createAnalyser();
      analyserR.fftSize = 256;

      sourceNode.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      // Start drawing the two‐channel meter
      const ctx = canvas.getContext('2d');
      function drawMeters() {
        const bufferLength = analyserL.frequencyBinCount;
        const dataArrayL = new Uint8Array(bufferLength);
        const dataArrayR = new Uint8Array(bufferLength);

        analyserL.getByteFrequencyData(dataArrayL);
        analyserR.getByteFrequencyData(dataArrayR);

        let sumL = 0,
          sumR = 0;
        for (let i = 0; i < bufferLength; i++) {
          sumL += dataArrayL[i] * dataArrayL[i];
          sumR += dataArrayR[i] * dataArrayR[i];
        }
        const rmsL = Math.sqrt(sumL / bufferLength) / 255;
        const rmsR = Math.sqrt(sumR / bufferLength) / 255;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        // Top half: left channel (green)
        const barL = Math.round(rmsL * width);
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(0, 0, barL, height / 2 - 2);

        // Bottom half: right channel (blue)
        const barR = Math.round(rmsR * width);
        ctx.fillStyle = '#2196f3';
        ctx.fillRect(0, height / 2 + 2, barR, height / 2 - 2);

        const rafId = requestAnimationFrame(drawMeters);
        peers.get(remoteId).rafId = rafId;
      }
      drawMeters();

      // Save references so we can clean up later
      const existing = peers.get(remoteId) || {};
      peers.set(remoteId, {
        ...existing,
        pc,
        entryEl,
        audioContext,
        analyserL,
        analyserR,
        rafId: null,
        mediaStream: remoteStream,
      });
    };

    // 4) Save the new peer (without audio nodes yet)
    peers.set(remoteId, {
      pc,
      entryEl,
      audioContext: null,
      analyserL: null,
      analyserR: null,
      rafId: null,
      mediaStream: null,
    });

    // 5) Notify remote to send an offer
    ws.send(JSON.stringify({ type: 'ready-for-offer', target: remoteId }));
  }

  /////////////////////////////////////////////////////
  // Handle incoming offer from remote, send answer
  /////////////////////////////////////////////////////
  async function handleOffer(remoteId, sdp) {
    const data = peers.get(remoteId);
    if (!data) return;
    const { pc } = data;

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
    } catch (err) {
      console.error(`Error handling offer from ${remoteId}:`, err);
    }
  }

  /////////////////////////////////////////////////////
  // Handle incoming ICE candidate from remote
  /////////////////////////////////////////////////////
  async function handleCandidate(remoteId, candidate) {
    const data = peers.get(remoteId);
    if (!data || !data.pc.remoteDescription) {
      console.warn(`No PC or remoteDescription for ${remoteId} yet.`);
      return;
    }
    try {
      await data.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(`Error adding ICE candidate for ${remoteId}:`, err);
    }
  }

  /////////////////////////////////////////////////////
  // Teardown a remote’s UI and audio resources
  /////////////////////////////////////////////////////
  function teardownPeer(remoteId) {
    const data = peers.get(remoteId);
    if (!data) return;

    const { pc, entryEl, audioContext, rafId } = data;

    // 1) Cancel animation frame
    if (rafId) {
      cancelAnimationFrame(rafId);
    }

    // 2) Close audioContext
    if (audioContext) {
      audioContext.close();
    }

    // 3) Close RTCPeerConnection
    if (pc) {
      pc.close();
    }

    // 4) Remove UI element
    if (entryEl && entryEl.parentNode === remotesContainer) {
      remotesContainer.removeChild(entryEl);
    }

    peers.delete(remoteId);
    mediaStreamsToRecord.delete(remoteId);
  }

  /////////////////////////////////////////////////////
  // Initialize recording controls
  /////////////////////////////////////////////////////
  function initRecordingControls() {
    // Create buttons and waveform canvas dynamically or assume they exist in HTML.
    // For simplicity, we assume the following HTML is present in studio.html:
    //
    // <button id="recordBtn">Start Recording</button>
    // <button id="stopRecordBtn" disabled>Stop Recording</button>
    // <span id="recTimer">00:00</span>
    // <canvas id="waveformCanvas" width="800" height="200"></canvas>
    //
    recordBtn = document.getElementById('recordBtn');
    stopRecordBtn = document.getElementById('stopRecordBtn');
    recorderTimerSpan = document.getElementById('recTimer');
    waveformCanvas = document.getElementById('waveformCanvas');

    recordBtn.onclick = startRecording;
    stopRecordBtn.onclick = stopRecording;
  }

  /////////////////////////////////////////////////////
  // Start multi‐track recording
  /////////////////////////////////////////////////////
  async function startRecording() {
    if (mediaStreamsToRecord.size === 0) {
      alert('No remotes connected – nothing to record.');
      return;
    }

    recordBtn.disabled = true;
    stopRecordBtn.disabled = false;

    // 1) Create a new AudioContext for mixing all tracks (including optional studio mic)
    studioAudioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });

    // 2) Create a destination node for the studio “mix” (if desired)
    const mixedDest = studioAudioContext.createMediaStreamDestination();

    // 3) For each remote’s MediaStream, create a MediaStreamSource → connect to mix
    mediaStreamsToRecord.forEach((remoteStream, remoteId) => {
      const srcNode = studioAudioContext.createMediaStreamSource(remoteStream);
      srcNode.connect(mixedDest);
      // Also set up a separate MediaRecorder for each remote if you want individual files
      const recorder = new MediaRecorder(remoteStream);
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        uploadRecording(`${remoteId}.webm`, blob);
      };
      recorder.start();
      remoteRecorders.set(remoteId, recorder);
    });

    // 4) Optionally capture studio mic as a separate track (uncomment if you want)
    // try {
    //   const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    //   const micSrc = studioAudioContext.createMediaStreamSource(micStream);
    //   micSrc.connect(mixedDest);
    //   const micRecorder = new MediaRecorder(micStream);
    //   const micChunks = [];
    //   micRecorder.ondataavailable = (e) => {
    //     if (e.data.size > 0) micChunks.push(e.data);
    //   };
    //   micRecorder.onstop = () => {
    //     const blob = new Blob(micChunks, { type: 'audio/webm' });
    //     uploadRecording(`studio_mic.webm`, blob);
    //   };
    //   micRecorder.start();
    //   remoteRecorders.set('studio_mic', micRecorder);
    // } catch (err) {
    //   console.warn('Studio mic unavailable:', err);
    // }

    // 5) Also create a combined recorder (studio mix of all remotes) if you want a single file
    studioRecorder = new MediaRecorder(mixedDest.stream);
    const combinedChunks = [];
    studioRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        combinedChunks.push(e.data);
      }
    };
    studioRecorder.onstop = () => {
      const blob = new Blob(combinedChunks, { type: 'audio/webm' });
      uploadRecording(`combined_${Date.now()}.webm`, blob);
    };
    studioRecorder.start();

    // 6) Start drawing real‐time waveform on waveformCanvas
    drawWaveform(mixedDest.stream);

    // 7) Start timer
    recordingStartTime = Date.now();
    recorderTimerInterval = setInterval(updateTimer, 500);
  }

  /////////////////////////////////////////////////////
  // Stop recording
  /////////////////////////////////////////////////////
  function stopRecording() {
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;

    // 1) Stop all remote recorders
    remoteRecorders.forEach((recorder) => {
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
      }
    });
    remoteRecorders.clear();

    // 2) Stop studio combined recorder
    if (studioRecorder && studioRecorder.state === 'recording') {
      studioRecorder.stop();
      studioRecorder = null;
    }

    // 3) Stop waveform drawing
    cancelAnimationFrame(drawingRaf);
    clearCanvas(waveformCanvas);
    drawingRaf = null;

    // 4) Stop timer
    clearInterval(recorderTimerInterval);
    recorderTimerInterval = null;
    recorderTimerSpan.textContent = '00:00';
  }

  /////////////////////////////////////////////////////
  // Upload a single recording blob to server
  /////////////////////////////////////////////////////
  async function uploadRecording(filename, blob) {
    const formData = new FormData();
    formData.append('files', blob, filename);
    try {
      const resp = await fetch('/upload', {
        method: 'POST',
        body: formData,
      });
      const json = await resp.json();
      console.log('Uploaded:', json.uploaded);
    } catch (err) {
      console.error('Upload error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Draw real‐time waveform for a given MediaStream
  /////////////////////////////////////////////////////
  let drawingRaf = null;
  function drawWaveform(stream) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const canvas = waveformCanvas;
    const ctx = canvas.getContext('2d');
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      analyser.getByteTimeDomainData(dataArray);

      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0f0';
      ctx.beginPath();

      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      drawingRaf = requestAnimationFrame(draw);
    }
    draw();
  }

  function clearCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /////////////////////////////////////////////////////
  // Update recording timer display
  /////////////////////////////////////////////////////
  function updateTimer() {
    const elapsedMs = Date.now() - recordingStartTime;
    const seconds = Math.floor(elapsedMs / 1000);
    const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
    const secs = String(seconds % 60).padStart(2, '0');
    recorderTimerSpan.textContent = `${mins}:${secs}`;
  }

  /////////////////////////////////////////////////////
  // ENTRY POINT
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    initWebSocket();
    initRecordingControls();
  });
})();
