/**
 * studio.js (v11.2)
 *
 * - Core WebRTC signaling and UI for studio control:
 *    • PPM meters for studio mic and each remote (with numeric scale)
 *    • Bitrate & jitter graphs per remote (updated via getStats)
 *    • Multi‐track recording: records studio mic + each remote as separate tracks, live waveforms, timer, downloads
 *    • Caller‐to‐caller routing: mix (Studio + Caller A) → Caller B, with renegotiation
 *    • Chat window, mute/unmute per remote, kick buttons
 *    • Sports support:
 *        - Receives "score-update" → displays alert or scoreboard
 *        - Receives "goal" → flashes that remote red for 20s (or until Accept)
 *        - Receives "reporter-recording" → decodes base64, shows <audio> playback in that remote’s UI
 *
 * - Signaling over WebSocket (ws library on server):
 *    Supported message types sent from studio → server: join, connect-remote, answer, candidate, mute-update, kick-remote, bitrate-update, offer (for routing renegotiation)
 *    Received from server: existing-remotes, new-remote, remote-state-change, offer (from remote), candidate (from remote), remote-disconnected, chat, mute-update (from remote), bitrate-update (noop here), score-update, goal, reporter-recording, error
 */

(() => {
  // TURN/STUN configuration
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
  // peers: Map<remoteID, { ... }>
  const peers = new Map();

  // UI references
  const waitingListEl = document.getElementById('waiting-list');
  const contributorListEl = document.getElementById('contributors-list');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  // Studio mic PPM
  const studioMeterCanvas = document.getElementById('studio-meter');
  const studioMeterCtx = studioMeterCanvas.getContext('2d');
  let studioAudioStream = null;
  let studioAnalyser = null;
  let studioPPMPeak = 0;
  let studioAudioTrack = null;

  // Recording UI
  const startRecBtn = document.getElementById('startRecBtn');
  const stopRecBtn = document.getElementById('stopRecBtn');
  const recordTimerEl = document.getElementById('recordTimer');
  const waveformsContainer = document.getElementById('waveforms-container');

  let recording = false;
  let recordingStartTime = 0;
  let recordTimerInterval = null;
  const mediaRecorders = []; // array of MediaRecorder
  let recordedBlobs = {};    // must be let so we can clear it

  /////////////////////////////////////////////////////
  // INITIALIZATION
  /////////////////////////////////////////////////////
  async function init() {
    await initStudioMicPPM();
    initWebSocket();

    startRecBtn.addEventListener('click', startRecording);
    stopRecBtn.addEventListener('click', stopRecording);
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
  // HANDLE SIGNALING MESSAGES
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

      case 'bitrate-update':
        // No action here; remotes handle it on their side
        break;

      case 'score-update':
        displayScoreboardUpdate(msg.teamA, msg.teamB, msg.scoreA, msg.scoreB);
        break;

      case 'goal':
        highlightGoal(msg.from);
        break;

      case 'reporter-recording':
        displayReporterSegment(msg.from, msg.name, msg.data);
        break;

      case 'error':
        console.error('Error from server:', msg.message);
        break;

      default:
        console.warn('Unknown message type (studio):', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // STUDIO MIC PPM INITIALIZATION
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
    studioPPMPeak = maxAmp > studioPPMPeak ? maxAmp : Math.max(studioPPMPeak - 0.005, 0);

    const width = studioMeterCanvas.width;
    const height = studioMeterCanvas.height;
    studioMeterCtx.clearRect(0, 0, width, height);

    // Numeric scale (0.00 to 1.00)
    studioMeterCtx.fillStyle = '#fff';
    studioMeterCtx.font = '10px sans-serif';
    studioMeterCtx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * width;
      studioMeterCtx.fillRect(x, height - 10, 1, 10);
      const label = (i / 4).toFixed(2);
      studioMeterCtx.fillText(label, x, height - 12);
    }

    // Current level (green)
    const levelWidth = maxAmp * width;
    studioMeterCtx.fillStyle = '#4caf50';
    studioMeterCtx.fillRect(0, 0, levelWidth, height - 12);

    // Peak hold line (red)
    const peakX = studioPPMPeak * width;
    studioMeterCtx.fillStyle = '#f44336';
    studioMeterCtx.fillRect(peakX - 1, 0, 2, height - 12);

    requestAnimationFrame(drawStudioPPM);
  }

  /////////////////////////////////////////////////////
  // ADD REMOTE TO UI
  /////////////////////////////////////////////////////
  function addRemoteToUI(remoteID, remoteName, state) {
    if (peers.has(remoteID)) return;
    const entry = {
      id: remoteID,
      name: remoteName,
      state,
      pendingCandidates: [],
      liWaiting: null,
      liConnected: null,
      pc: null,
      audioElementRemoteToStudio: null,
      audioElementStudioToRemote: null,
      metreCanvas: null,
      metreContext: null,
      analyserL: null,
      analyserR: null,
      ppmPeak: 0,
      bitrateSelector: null,
      bitrateCanvas: null,
      bitrateContext: null,
      jitterCanvas: null,
      jitterContext: null,
      stats: { lastBytes: 0, lastTimestamp: 0, bitrateData: [], jitterData: [] },
      statsInterval: null,
      routeSelector: null,
      currentRouteSender: null,
      recordAnalyser: null,
      recordWaveformCanvas: null,
      recordWaveformCtx: null,
      muteBtn: null,
      kickBtn: null,
      remoteMuted: false,
      localMuted: false,
    };

    // **Waiting List Item**
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

    entry.liWaiting = liWait;
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
    }
    waitingListEl.appendChild(liWait);

    peers.set(remoteID, entry);

    // If remote is already 'connected' at init
    if (state === 'connected') {
      entry.liWaiting.remove();
      entry.liWaiting = null;
      addConnectedUI(remoteID);
    }
  }

  /////////////////////////////////////////////////////
  // UPDATE REMOTE STATE
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
  // ADD CONNECTED REMOTE UI
  /////////////////////////////////////////////////////
  function addConnectedUI(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || entry.liConnected) return;

    // Build the connected list item
    const liConn = document.createElement('li');
    liConn.id = `connected-${remoteID}`;
    liConn.className = 'contributor-item';

    // Name + Status
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = entry.name;
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
    ].forEach((opt) => {
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

    // Caller‐to‐Caller routing dropdown
    const routeLabel = document.createElement('label');
    routeLabel.textContent = 'Route to:';
    liConn.appendChild(routeLabel);

    const routeSelector = document.createElement('select');
    routeSelector.className = 'route-select';
    routeSelector.id = `routeSelector-${remoteID}`;
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '—';
    routeSelector.appendChild(defaultOpt);
    routeSelector.onchange = () => {
      const targetID = routeSelector.value;
      if (targetID && peers.has(targetID)) {
        routeAudio(remoteID, targetID);
      } else {
        stopRouting(remoteID, targetID);
      }
    };
    liConn.appendChild(routeSelector);
    entry.routeSelector = routeSelector;

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
      if (confirm(`Kick ${entry.name}?`)) {
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

    // PPM meter
    const metreCanvas = document.createElement('canvas');
    metreCanvas.width = 300;
    metreCanvas.height = 50;
    metreCanvas.className = 'ppm-meter';
    metreCanvas.id = `meter-${remoteID}`;
    liConn.appendChild(metreCanvas);
    entry.metreCanvas = metreCanvas;
    entry.metreContext = metreCanvas.getContext('2d');

    // Bitrate graph label & canvas
    const brLabelDiv = document.createElement('div');
    brLabelDiv.textContent = 'Bitrate (kbps)';
    liConn.appendChild(brLabelDiv);

    const bitrateCanvas = document.createElement('canvas');
    bitrateCanvas.width = 300;
    bitrateCanvas.height = 100;
    bitrateCanvas.className = 'graph-canvas';
    bitrateCanvas.id = `bitrate-${remoteID}`;
    liConn.appendChild(bitrateCanvas);
    entry.bitrateCanvas = bitrateCanvas;
    entry.bitrateContext = bitrateCanvas.getContext('2d');

    // Jitter graph label & canvas
    const jitLabelDiv = document.createElement('div');
    jitLabelDiv.textContent = 'Jitter (ms)';
    liConn.appendChild(jitLabelDiv);

    const jitterCanvas = document.createElement('canvas');
    jitterCanvas.width = 300;
    jitterCanvas.height = 100;
    jitterCanvas.className = 'graph-canvas';
    jitterCanvas.id = `jitter-${remoteID}`;
    liConn.appendChild(jitterCanvas);
    entry.jitterCanvas = jitterCanvas;
    entry.jitterContext = jitterCanvas.getContext('2d');

    // Recording waveform canvas (for this remote’s track)
    const wfWrapper = document.createElement('div');
    wfWrapper.style.display = 'flex';
    wfWrapper.style.alignItems = 'center';
    wfWrapper.style.marginTop = '10px';
    wfWrapper.innerHTML = `<strong>Waveform (${entry.name}):</strong>`;
    const waveformCanvas = document.createElement('canvas');
    waveformCanvas.width = 300;
    waveformCanvas.height = 60;
    waveformCanvas.className = 'waveform-canvas';
    waveformCanvas.id = `waveform-${remoteID}`;
    wfWrapper.appendChild(waveformCanvas);
    liConn.appendChild(wfWrapper);
    entry.recordWaveformCanvas = waveformCanvas;
    entry.recordWaveformCtx = waveformCanvas.getContext('2d');
    entry.recordAnalyser = null; // to be set when the remote audio track arrives

    // Append to connected list
    contributorListEl.appendChild(liConn);
    entry.liConnected = liConn;

    // Ensure audio elements exist for ontrack
    if (!entry.audioElementRemoteToStudio) {
      const audioRemote = document.createElement('audio');
      audioRemote.id = `audio-remote-${remoteID}`;
      audioRemote.autoplay = true;
      audioRemote.controls = false;
      audioRemote.muted = false;
      document.body.appendChild(audioRemote);
      entry.audioElementRemoteToStudio = audioRemote;
    }
    if (!entry.audioElementStudioToRemote) {
      const audioStudio = document.createElement('audio');
      audioStudio.id = `audio-studio-${remoteID}`;
      audioStudio.autoplay = true;
      audioStudio.controls = false;
      audioStudio.muted = false;
      document.body.appendChild(audioStudio);
      entry.audioElementStudioToRemote = audioStudio;
    }

    entry.analyserL = null;
    entry.analyserR = null;
    entry.ppmPeak = 0;

    // Enable Mute button now that UI exists
    entry.muteBtn.disabled = false;

    // Refresh routing dropdowns
    populateRouteOptions();
  }

  /////////////////////////////////////////////////////
  // REMOVE REMOTE & CLEANUP
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
    if (entry.metreCanvas) entry.metreCanvas.remove();
    if (entry.bitrateCanvas) entry.bitrateCanvas.remove();
    if (entry.jitterCanvas) entry.jitterCanvas.remove();
    if (entry.recordWaveformCanvas) entry.recordWaveformCanvas.remove();

    peers.delete(remoteID);
    populateRouteOptions();
  }

  /////////////////////////////////////////////////////
  // HANDLE OFFER FROM REMOTE → Create PC, add Studio track, answer
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    // Ensure we have the studioAudioTrack
    if (!studioAudioTrack && studioAudioStream) {
      studioAudioTrack = studioAudioStream.getAudioTracks()[0];
    }

    // Create PC if missing
    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      // Add Studio → Remote track
      if (studioAudioTrack) {
        pc.addTrack(
          studioAudioTrack,
          studioAudioStream || new MediaStream([studioAudioTrack])
        );
      }

      // Parse Opus codec info, append to status
      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      // ontrack: attach incoming audio
      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;

        // Ensure remote audio element exists
        if (!entry.audioElementRemoteToStudio) {
          const audioRemote = document.createElement('audio');
          audioRemote.id = `audio-remote-${remoteID}`;
          audioRemote.autoplay = true;
          audioRemote.controls = false;
          audioRemote.muted = false;
          document.body.appendChild(audioRemote);
          entry.audioElementRemoteToStudio = audioRemote;
        }

        // First audio track: remote→studio
        if (!entry.audioElementRemoteToStudio.srcObject) {
          entry.audioElementRemoteToStudio.srcObject = incomingStream;
          setupRemotePPM(remoteID, incomingStream);

          // Recording waveform analyser
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const srcNode = audioCtx.createMediaStreamSource(incomingStream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          srcNode.connect(analyser);
          entry.recordAnalyser = analyser;
        }
        // Second audio track: studio→remote echo or routed mix
        else {
          // Ensure studio→remote audio element exists
          if (!entry.audioElementStudioToRemote) {
            const audioStudio = document.createElement('audio');
            audioStudio.id = `audio-studio-${remoteID}`;
            audioStudio.autoplay = true;
            audioStudio.controls = false;
            audioStudio.muted = false;
            document.body.appendChild(audioStudio);
            entry.audioElementStudioToRemote = audioStudio;
          }
          if (!entry.audioElementStudioToRemote.srcObject && evt.track.kind === 'audio') {
            entry.audioElementStudioToRemote.srcObject = incomingStream;
          }
        }
      };

      // ICE candidates
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

      // Connection state change
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

    // Set remote description
    try {
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp })
      );
    } catch (err) {
      console.error(`Failed to set remote description for ${remoteID}:`, err);
      return;
    }

    // Drain queued ICE candidates
    if (entry.pendingCandidates.length > 0) {
      entry.pendingCandidates.forEach((c) => {
        entry.pc
          .addIceCandidate(new RTCIceCandidate(c))
          .catch((e) => console.error('Error adding queued ICE candidate:', e));
      });
      entry.pendingCandidates = [];
    }

    // Create answer
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
  // HANDLE ICE CANDIDATE FROM REMOTE
  /////////////////////////////////////////////////////
  function handleCandidate(from, candidate) {
    const entry = peers.get(from);
    if (!entry) return;
    if (!entry.pc || !entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    entry.pc
      .addIceCandidate(new RTCIceCandidate(candidate))
      .catch((err) => console.error(`Error adding ICE candidate for ${from}:`, err));
  }

  /////////////////////////////////////////////////////
  // HANDLE MUTE UPDATE FROM REMOTE
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
  // PARSE OPUS INFO FROM SDP
  /////////////////////////////////////////////////////
  function parseOpusInfo(sdp) {
    const lines = sdp.split('\n');
    let opusPayloadType = null;
    const fmtMap = new Map();
    let sampling = null,
      channels = null;

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
    return opusPayloadType && fmtMap.has(opusPayloadType)
      ? fmtMap.get(opusPayloadType)
      : null;
  }

  /////////////////////////////////////////////////////
  // SETUP REMOTE PPM METER & RECORD WAVEFORM
  /////////////////////////////////////////////////////
  function setupRemotePPM(remoteID, stream) {
    const entry = peers.get(remoteID);
    if (!entry) return;

    // Only proceed if metreCanvas exists
    if (!entry.metreCanvas) return;

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
    if (!entry.metreCanvas) return; // guard against null canvas

    const canvas = entry.metreCanvas;
    const ctx = entry.metreContext;
    const width = canvas.width;
    const height = canvas.height;

    // Numeric scale (0.00 to 1.00)
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

    entry.ppmPeak = maxAmp > entry.ppmPeak ? maxAmp : Math.max(entry.ppmPeak - 0.005, 0);

    const levelWidth = maxAmp * width;
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(0, 0, levelWidth, height - 12);

    const peakX = entry.ppmPeak * width;
    ctx.fillStyle = '#f44336';
    ctx.fillRect(peakX - 1, 0, 2, height - 12);

    requestAnimationFrame(() => drawRemotePPM(remoteID));
  }

  /////////////////////////////////////////////////////
  // START STATS POLLING (Bitrate & Jitter)
  /////////////////////////////////////////////////////
  function startStats(remoteID) {
    const entry = peers.get(remoteID);
    if (!entry || !entry.pc) return;
    entry.stats = { lastBytes: 0, lastTimestamp: 0, bitrateData: [], jitterData: [] };
    entry.statsInterval = setInterval(async () => {
      const stats = await entry.pc.getStats();
      stats.forEach((report) => {
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
      const y = height - Math.min((val / 200) * height, height); // scale max 200 kbps
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
      const y = height - Math.min((val / 100) * height, height); // scale max 100 ms
      i === 0 ? jCtx.moveTo(x, y) : jCtx.lineTo(x, y);
    });
    jCtx.stroke();
  }

  /////////////////////////////////////////////////////
  // HANDLE OFFER FROM REMOTE
  /////////////////////////////////////////////////////
  async function handleOffer(remoteID, sdp) {
    const entry = peers.get(remoteID);
    if (!entry) {
      console.error('Received offer for unknown remote:', remoteID);
      return;
    }

    // Ensure we have studioAudioTrack
    if (!studioAudioTrack && studioAudioStream) {
      studioAudioTrack = studioAudioStream.getAudioTracks()[0];
    }

    // Create PC if absent
    if (!entry.pc) {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;

      // Add Studio → Remote track
      if (studioAudioTrack) {
        pc.addTrack(
          studioAudioTrack,
          studioAudioStream || new MediaStream([studioAudioTrack])
        );
      }

      // Parse Opus codec info
      const codecInfo = parseOpusInfo(sdp);
      if (codecInfo) {
        entry.statusSpan.textContent += ` [codec: ${codecInfo}]`;
      }

      // ontrack: handle incoming audio
      pc.ontrack = (evt) => {
        const [incomingStream] = evt.streams;

        // Ensure remote audio element exists
        if (!entry.audioElementRemoteToStudio) {
          const audioRemote = document.createElement('audio');
          audioRemote.id = `audio-remote-${remoteID}`;
          audioRemote.autoplay = true;
          audioRemote.controls = false;
          audioRemote.muted = false;
          document.body.appendChild(audioRemote);
          entry.audioElementRemoteToStudio = audioRemote;
        }

        // First audio track: remote→studio
        if (!entry.audioElementRemoteToStudio.srcObject) {
          entry.audioElementRemoteToStudio.srcObject = incomingStream;
          setupRemotePPM(remoteID, incomingStream);

          // Recording waveform analyser
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const srcNode = audioCtx.createMediaStreamSource(incomingStream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          srcNode.connect(analyser);
          entry.recordAnalyser = analyser;
        }
        // Second audio track: studio→remote echo or routed mix
        else {
          // Ensure studio→remote audio element exists
          if (!entry.audioElementStudioToRemote) {
            const audioStudio = document.createElement('audio');
            audioStudio.id = `audio-studio-${remoteID}`;
            audioStudio.autoplay = true;
            audioStudio.controls = false;
            audioStudio.muted = false;
            document.body.appendChild(audioStudio);
            entry.audioElementStudioToRemote = audioStudio;
          }
          if (!entry.audioElementStudioToRemote.srcObject && evt.track.kind === 'audio') {
            entry.audioElementStudioToRemote.srcObject = incomingStream;
          }
        }
      };

      // ICE candidates
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

      // Connection state change
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

    // Set remote description
    try {
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp })
      );
    } catch (err) {
      console.error(`Failed to set remote description for ${remoteID}:`, err);
      return;
    }

    // Drain queued ICE candidates
    if (entry.pendingCandidates.length > 0) {
      entry.pendingCandidates.forEach((c) => {
        entry.pc
          .addIceCandidate(new RTCIceCandidate(c))
          .catch((e) => console.error('Error adding queued ICE candidate:', e));
      });
      entry.pendingCandidates = [];
    }

    // Create answer
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
  // HANDLE ICE CANDIDATE FROM REMOTE
  /////////////////////////////////////////////////////
  function handleCandidate(from, candidate) {
    const entry = peers.get(from);
    if (!entry) return;
    if (!entry.pc || !entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    entry.pc
      .addIceCandidate(new RTCIceCandidate(candidate))
      .catch((err) => console.error(`Error adding ICE candidate for ${from}:`, err));
  }

  /////////////////////////////////////////////////////
  // HANDLE MUTE UPDATE FROM REMOTE
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
  // PARSE OPUS INFO FROM SDP
  /////////////////////////////////////////////////////
  function parseOpusInfo(sdp) {
    const lines = sdp.split('\n');
    let opusPayloadType = null;
    const fmtMap = new Map();
    let sampling = null,
      channels = null;

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
    return opusPayloadType && fmtMap.has(opusPayloadType)
      ? fmtMap.get(opusPayloadType)
      : null;
  }

  /////////////////////////////////////////////////////
  // ROUTING: mix (Studio + source) → target
  /////////////////////////////////////////////////////
  async function routeAudio(sourceID, targetID) {
    const srcEntry = peers.get(sourceID);
    const dstEntry = peers.get(targetID);
    if (!srcEntry || !dstEntry) return;

    // Build a mix: Studio mic + source remote
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const destNode = audioCtx.createMediaStreamDestination();

    // Studio mic
    if (studioAudioStream) {
      const studioSource = audioCtx.createMediaStreamSource(studioAudioStream);
      studioSource.connect(destNode);
    }
    // Source remote
    const remoteStream = srcEntry.audioElementRemoteToStudio
      ? srcEntry.audioElementRemoteToStudio.srcObject
      : null;
    if (remoteStream) {
      const remoteSource = audioCtx.createMediaStreamSource(remoteStream);
      remoteSource.connect(destNode);
    }

    // Mixed track
    const mixedTrack = destNode.stream.getAudioTracks()[0];

    // Add to target PC
    if (dstEntry.pc) {
      const sender = dstEntry.pc.addTrack(mixedTrack, destNode.stream);
      dstEntry.currentRouteSender = sender;

      // Renegotiate: create new offer
      const offer = await dstEntry.pc.createOffer();
      await dstEntry.pc.setLocalDescription(offer);
      ws.send(
        JSON.stringify({
          type: 'offer',
          from: 'studio',
          target: targetID,
          sdp: dstEntry.pc.localDescription.sdp,
        })
      );
    }
  }

  /////////////////////////////////////////////////////
  // STOP ROUTING
  /////////////////////////////////////////////////////
  async function stopRouting(sourceID, targetID) {
    const dstEntry = peers.get(targetID);
    if (!dstEntry || !dstEntry.currentRouteSender) return;
    dstEntry.pc.removeTrack(dstEntry.currentRouteSender);
    dstEntry.currentRouteSender = null;

    // Renegotiate to drop the track
    const offer = await dstEntry.pc.createOffer();
    await dstEntry.pc.setLocalDescription(offer);
    ws.send(
      JSON.stringify({
        type: 'offer',
        from: 'studio',
        target: targetID,
        sdp: dstEntry.pc.localDescription.sdp,
      })
    );
  }

  /////////////////////////////////////////////////////
  // POPULATE ROUTING DROPDOWNS
  /////////////////////////////////////////////////////
  function populateRouteOptions() {
    const remoteIDs = Array.from(peers.keys()).filter(
      (id) => peers.get(id).state === 'connected'
    );
    peers.forEach((entry, id) => {
      if (!entry.routeSelector) return;
      entry.routeSelector.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '—';
      entry.routeSelector.appendChild(defaultOpt);
      remoteIDs
        .filter((rid) => rid !== id)
        .forEach((rid) => {
          const o = document.createElement('option');
          o.value = rid;
          o.textContent = peers.get(rid).name;
          entry.routeSelector.appendChild(o);
        });
    });
  }

  /////////////////////////////////////////////////////
  // MULTI‐TRACK RECORDING
  /////////////////////////////////////////////////////
  function startRecording() {
    if (recording) return;
    recording = true;
    startRecBtn.disabled = true;
    stopRecBtn.disabled = false;

    waveformsContainer.innerHTML = '';
    recordedBlobs = {}; // <=== Clear recordedBlobs

    recordingStartTime = Date.now();
    recordTimerEl.textContent = '00:00:00';
    recordTimerInterval = setInterval(updateRecordTimer, 1000);

    // Studio track
    if (studioAudioStream) {
      setupTrackRecording('studio', studioAudioStream);
    }

    // Each remote’s track
    peers.forEach((entry, remoteID) => {
      const remoteStream = entry.audioElementRemoteToStudio
        ? entry.audioElementRemoteToStudio.srcObject
        : null;
      if (remoteStream) {
        setupTrackRecording(remoteID, remoteStream);
      }
    });
  }

  function updateRecordTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    recordTimerEl.textContent = `${hh}:${mm}:${ss}`;
  }

  function setupTrackRecording(trackID, stream) {
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    const blobs = [];
    recordedBlobs[trackID] = blobs;

    recorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) {
        blobs.push(evt.data);
      }
    };
    recorder.onstop = () => {
      const superBuffer = new Blob(blobs, { type: 'audio/webm' });
      const url = window.URL.createObjectURL(superBuffer);
      const downloadLink = document.createElement('a');
      downloadLink.href = url;
      downloadLink.download = `${trackID}-recording.webm`;
      downloadLink.textContent = `Download ${trackID}.webm`;
      downloadLink.style.display = 'block';
      waveformsContainer.appendChild(downloadLink);
    };

    // Create waveform canvas
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 60;
    canvas.className = 'waveform-canvas';
    waveformsContainer.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    // Attach analyser
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    srcNode.connect(analyser);

    const animateWaveform = () => {
      if (!recording) return;
      const bufferLength = analyser.fftSize;
      const dataArray = new Float32Array(bufferLength);
      analyser.getFloatTimeDomainData(dataArray);

      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#4caf50';
      ctx.beginPath();
      let x = 0;
      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] * 0.5 + 0.5;
        const y = v * canvas.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      requestAnimationFrame(animateWaveform);
    };
    animateWaveform();

    recorder.start();
    mediaRecorders.push(recorder);
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    startRecBtn.disabled = false;
    stopRecBtn.disabled = true;
    clearInterval(recordTimerInterval);

    mediaRecorders.forEach((rec) => {
      if (rec.state === 'recording') rec.stop();
    });
    mediaRecorders.length = 0;
  }

  /////////////////////////////////////////////////////
  // HIGHLIGHT REMOTE FOR GOAL
  /////////////////////////////////////////////////////
  function highlightGoal(remoteID) {
    const li = document.getElementById(`connected-${remoteID}`);
    if (!li) return;
    li.style.backgroundColor = '#ff4d4d';

    if (!li.querySelector('.accept-goal-btn')) {
      const acceptBtn = document.createElement('button');
      acceptBtn.textContent = 'Accept Goal';
      acceptBtn.className = 'accept-goal-btn';
      acceptBtn.style.marginLeft = '10px';
      acceptBtn.onclick = () => {
        li.style.backgroundColor = '';
        acceptBtn.remove();
      };
      li.appendChild(acceptBtn);
    }

    setTimeout(() => {
      li.style.backgroundColor = '';
      const acc = li.querySelector('.accept-goal-btn');
      if (acc) acc.remove();
    }, 20000);
  }

  /////////////////////////////////////////////////////
  // DISPLAY SCOREBOARD UPDATE
  /////////////////////////////////////////////////////
  function displayScoreboardUpdate(teamA, teamB, scoreA, scoreB) {
    alert(`Score Update:\n${teamA} ${scoreA} - ${scoreB} ${teamB}`);
  }

  /////////////////////////////////////////////////////
  // DISPLAY REPORTER SEGMENT PLAYBACK
  /////////////////////////////////////////////////////
  function displayReporterSegment(fromID, reporterName, base64Data) {
    const li = document.getElementById(`connected-${fromID}`);
    if (!li) return;

    // Remove existing player if present
    const existing = li.querySelector('.reporter-segment-player');
    if (existing) existing.remove();

    // Convert base64 → Blob
    const binary = atob(base64Data);
    const len = binary.length;
    const buffer = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      buffer[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([buffer], { type: 'audio/webm' });
    const url = window.URL.createObjectURL(blob);

    const wrapper = document.createElement('div');
    wrapper.className = 'reporter-segment-player';
    wrapper.style.marginTop = '10px';

    const label = document.createElement('div');
    label.innerHTML = `<strong>${reporterName}’s Segment:</strong>`;
    wrapper.appendChild(label);

    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    audioEl.src = url;
    wrapper.appendChild(audioEl);

    li.appendChild(wrapper);
  }

  /////////////////////////////////////////////////////
  // APPEND CHAT MESSAGE
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
  // DOCUMENT READY
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    init();
  });
})();
