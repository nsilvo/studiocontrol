/**
 * public/js/sports.js
 *
 * Front-end logic for a sports reporter.
 * - Extends remote.js functionality with:
 *   • Reporter name, team names, scoreboard controls
 *   • “Goal!” button → notifies studio, which flashes remote red
 *   • Local “Start Segment”/“Stop Segment” recording → sends blob to studio for playback
 *   • Retains remote audio controls (mute, tone, listen, bitrate)
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
  let pc = null;
  let localStream = null;
  let audioSender = null;
  let localID = null;
  let reporterName = '';
  let teamA = '';
  let teamB = '';
  let isMuted = false;
  let isTone = false;
  let toneOsc = null;
  let toneContext = null;
  let toneDest = null;

  // DOM elements
  const setupSection      = document.getElementById('setup-section');
  const reporterNameInput = document.getElementById('reporterNameInput');
  const teamAInput        = document.getElementById('teamAInput');
  const teamBInput        = document.getElementById('teamBInput');
  const connectBtn        = document.getElementById('connectBtn');

  const sportsUI          = document.getElementById('sports-ui');
  const muteSelfBtn       = document.getElementById('muteSelfBtn');
  const toneBtn           = document.getElementById('toneBtn');
  const listenStudioBtn   = document.getElementById('listenStudioBtn');
  const connStatusSpan    = document.getElementById('connStatus');
  const meterCanvas       = document.getElementById('meter-canvas');

  const bitrateSelector   = document.getElementById('bitrateSelector');

  const scoreAInput       = document.getElementById('scoreAInput');
  const scoreBInput       = document.getElementById('scoreBInput');
  const updateScoreBtn    = document.getElementById('updateScoreBtn');
  const goalBtn           = document.getElementById('goalBtn');

  const startSegmentBtn   = document.getElementById('startSegmentBtn');
  const stopSegmentBtn    = document.getElementById('stopSegmentBtn');
  const segmentPlayerContainer = document.getElementById('segmentPlayerContainer');

  const chatWindowEl      = document.getElementById('chatWindow');
  const chatInputEl       = document.getElementById('chatInput');
  const sendChatBtn       = document.getElementById('sendChatBtn');

  const audioStudioElem   = new Audio(); // we’ll attach stream once connected
  audioStudioElem.controls = true;
  audioStudioElem.style.display = 'none';
  document.body.appendChild(audioStudioElem);

  let audioContext = null;
  let analyserL = null;
  let analyserR = null;

  // For local segment recording
  let segmentRecorder = null;
  let recordedBlobs   = [];
  let isRecording     = false;

  // ────────────────────────────────────────────────────────────────────────
  // 1) SETUP: Reporter clicks “Connect”
  // ────────────────────────────────────────────────────────────────────────
  connectBtn.onclick = () => {
    const name = reporterNameInput.value.trim();
    const a = teamAInput.value.trim();
    const b = teamBInput.value.trim();
    if (!name || !a || !b) {
      alert('Please fill in Reporter Name, Team A, and Team B.');
      return;
    }
    reporterName = name;
    teamA = a;
    teamB = b;
    setupSection.style.display = 'none';
    sportsUI.style.display = 'block';
    connStatusSpan.textContent = 'Connecting WebSocket…';
    initWebSocket();
  };

  // ────────────────────────────────────────────────────────────────────────
  // 2) WEBSOCKET SETUP & MESSAGE HANDLING
  // ────────────────────────────────────────────────────────────────────────
  function initWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[sports] WS opened');
      connStatusSpan.textContent = 'WS connected. Joining…';
      ws.send(JSON.stringify({
        type: 'join',
        role: 'sports',
        name: reporterName,
        teamA,
        teamB
      }));
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        console.error('[sports] Invalid JSON:', e);
        return;
      }
      handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      console.warn('[sports] WS closed. Reconnecting in 5s…');
      connStatusSpan.textContent = 'WS disconnected. Reconnecting…';
      setTimeout(initWebSocket, 5000);
      if (pc) {
        pc.close();
        pc = null;
      }
    };

    ws.onerror = (err) => {
      console.error('[sports] WS error:', err);
      ws.close();
    };
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        // { type:'joined', id }
        localID = msg.id;
        console.log('[sports] Assigned ID:', localID);
        connStatusSpan.textContent = 'Waiting for studio call…';
        break;

      case 'start-call':
        // { type:'start-call' }
        connStatusSpan.textContent = 'Starting WebRTC…';
        await startWebRTC();
        break;

      case 'answer':
        // { type:'answer', sdp }
        await handleAnswer(msg.sdp);
        break;

      case 'candidate':
        // { type:'candidate', candidate }
        await handleCandidate(msg.candidate);
        break;

      case 'mute-update':
        handleMuteUpdate(msg.muted);
        break;

      case 'score-update':
        // { type:'score-update', teamA, teamB, scoreA, scoreB }
        alert(`Score Update: ${msg.teamA} ${msg.scoreA} – ${msg.scoreB} ${msg.teamB}`);
        break;

      case 'goal':
        // { type:'goal', from: remoteId }
        if (msg.from === localID) return; // ignore own
        flashGoalIndicator();
        break;

      case 'chat':
        // { type:'chat', from:'studio', text }
        appendChatMessage('Studio', msg.text);
        break;

      default:
        console.warn('[sports] Unknown message:', msg.type);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3) WEBRTC SETUP
  // ────────────────────────────────────────────────────────────────────────
  async function startWebRTC() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 2,
          noiseSuppression: true,
          echoCancellation: true
        }
      });
      setupPPMMeter(localStream);

      pc = new RTCPeerConnection(ICE_CONFIG);

      // Add mic track
      audioSender = pc.addTrack(localStream.getAudioTracks()[0], localStream);

      // Set initial bitrate
      setAudioBitrate(parseInt(bitrateSelector.value, 10));
      bitrateSelector.onchange = () => {
        setAudioBitrate(parseInt(bitrateSelector.value, 10));
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(JSON.stringify({
            type: 'candidate',
            from: localID,
            target: 'studio',
            candidate: e.candidate
          }));
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        connStatusSpan.textContent = state;
        console.log('[sports] Connection state:', state);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      ws.send(JSON.stringify({
        type: 'offer',
        from: localID,
        sdp: offer.sdp
      }));

      connStatusSpan.textContent = 'Offer sent. Awaiting answer…';
    } catch (e) {
      console.error('[sports] startWebRTC error:', e);
      connStatusSpan.textContent = 'Error starting call.';
    }
  }

  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      connStatusSpan.textContent = 'Connected to studio.';
    } catch (e) {
      console.error('[sports] setRemoteDescription error:', e);
    }
  }

  async function handleCandidate(candidate) {
    if (!pc || !pc.remoteDescription) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[sports] addIceCandidate error:', e);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4) MUTE UPDATE
  // ────────────────────────────────────────────────────────────────────────
  function handleMuteUpdate(muted) {
    if (localStream) {
      localStream.getAudioTracks().forEach(t => (t.enabled = !muted));
      connStatusSpan.textContent = muted ? 'You have been muted.' : 'You are unmuted.';
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5) CHAT
  // ────────────────────────────────────────────────────────────────────────
  function appendChatMessage(sender, text) {
    const div = document.createElement('div');
    div.textContent = `[${sender}]: ${text}`;
    chatWindowEl.appendChild(div);
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  }

  sendChatBtn.onclick = () => {
    const text = chatInputEl.value.trim();
    if (!text) return;
    ws.send(JSON.stringify({
      type: 'chat',
      fromRole: 'sports',
      fromId: localID,
      target: 'studio',
      text
    }));
    appendChatMessage('You', text);
    chatInputEl.value = '';
  };

  // ────────────────────────────────────────────────────────────────────────
  // 6) MUTE SELF, TONE, LISTEN
  // ────────────────────────────────────────────────────────────────────────
  muteSelfBtn.onclick = () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    muteSelfBtn.textContent = track.enabled ? 'Mute Myself' : 'Unmute Myself';
  };

  toneBtn.onclick = () => {
    if (!audioSender) {
      alert('Audio not yet streaming.');
      return;
    }
    if (!isTone) {
      toneContext = new (window.AudioContext || window.webkitAudioContext)();
      toneOsc = toneContext.createOscillator();
      toneOsc.type = 'sine';
      toneOsc.frequency.value = 1000;
      toneDest = toneContext.createMediaStreamDestination();
      toneOsc.connect(toneDest);
      toneOsc.start();
      audioSender.replaceTrack(toneDest.stream.getAudioTracks()[0]);
      connStatusSpan.textContent = 'Sending test tone…';
      toneBtn.textContent = 'Stop Test Tone';
      isTone = true;
    } else {
      toneOsc.stop();
      toneOsc.disconnect();
      audioSender.replaceTrack(localStream.getAudioTracks()[0]);
      connStatusSpan.textContent = 'Test tone stopped.';
      toneBtn.textContent = 'Send GLITS Tone';
      isTone = false;
    }
  };

  listenStudioBtn.onclick = () => {
    if (!audioStudioElem.srcObject) {
      alert('Not yet connected to studio audio.');
      return;
    }
    audioStudioElem.muted = !audioStudioElem.muted;
    listenStudioBtn.textContent = audioStudioElem.muted ? 'Listen to Studio' : 'Mute Studio';
  };

  // ────────────────────────────────────────────────────────────────────────
  // 7) SCOREBOARD & GOAL
  // ────────────────────────────────────────────────────────────────────────
  updateScoreBtn.onclick = () => {
    const sA = parseInt(scoreAInput.value, 10);
    const sB = parseInt(scoreBInput.value, 10);
    ws.send(JSON.stringify({
      type: 'score-update',
      teamA,
      teamB,
      scoreA: sA,
      scoreB: sB
    }));
  };

  goalBtn.onclick = () => {
    ws.send(JSON.stringify({
      type: 'goal',
      from: localID
    }));
    flashGoalIndicator();
  };

  function flashGoalIndicator() {
    sportsUI.style.backgroundColor = 'rgba(255,0,0,0.2)';
    setTimeout(() => {
      sportsUI.style.backgroundColor = '#fff';
    }, 2000);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 8) LOCAL SEGMENT RECORDING
  // ────────────────────────────────────────────────────────────────────────
  startSegmentBtn.onclick = () => {
    if (!localStream) {
      alert('No local audio to record.');
      return;
    }
    const options = { mimeType: 'audio/webm' };
    segmentRecorder = new MediaRecorder(localStream, options);
    recordedBlobs = [];
    segmentRecorder.ondataavailable = e => {
      if (e.data.size > 0) recordedBlobs.push(e.data);
    };
    segmentRecorder.onstop = () => {
      const blob = new Blob(recordedBlobs, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('audio');
      a.controls = true;
      a.src = url;
      segmentPlayerContainer.innerHTML = '';
      segmentPlayerContainer.appendChild(a);

      // Send blob to studio as base64
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        ws.send(JSON.stringify({
          type: 'reporter-recording',
          from: localID,
          name: reporterName,
          data: base64
        }));
      };
      reader.readAsDataURL(blob);
    };
    segmentRecorder.start();
    isRecording = true;
    startSegmentBtn.disabled = true;
    stopSegmentBtn.disabled = false;
  };

  stopSegmentBtn.onclick = () => {
    if (isRecording && segmentRecorder) {
      segmentRecorder.stop();
      isRecording = false;
      startSegmentBtn.disabled = false;
      stopSegmentBtn.disabled = true;
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  // 9) LOCAL PPM METER
  // ────────────────────────────────────────────────────────────────────────
  function setupPPMMeter(stream) {
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyserL = null;
      analyserR = null;
    }
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
    const source = audioContext.createMediaStreamSource(stream);
    const splitter = audioContext.createChannelSplitter(2);

    analyserL = audioContext.createAnalyser();
    analyserL.fftSize = 256;
    analyserR = audioContext.createAnalyser();
    analyserR.fftSize = 256;

    source.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    drawStereoMeter();
  }

  function drawStereoMeter() {
    if (!analyserL || !analyserR) return;
    const bufferLength = analyserL.frequencyBinCount;
    const dataArrayL = new Uint8Array(bufferLength);
    const dataArrayR = new Uint8Array(bufferLength);
    const ctx = meterCanvas.getContext('2d');
    const width = meterCanvas.clientWidth;
    const height = meterCanvas.clientHeight;

    function draw() {
      analyserL.getByteFrequencyData(dataArrayL);
      analyserR.getByteFrequencyData(dataArrayR);

      let sumL = 0, sumR = 0;
      for (let i = 0; i < bufferLength; i++) {
        sumL += dataArrayL[i] * dataArrayL[i];
        sumR += dataArrayR[i] * dataArrayR[i];
      }
      const rmsL = Math.sqrt(sumL / bufferLength) / 255;
      const rmsR = Math.sqrt(sumR / bufferLength) / 255;

      ctx.clearRect(0, 0, width, height);

      // Top half: left channel (green)
      const barL = Math.round(rmsL * width);
      ctx.fillStyle = '#4caf50';
      ctx.fillRect(0, 0, barL, height / 2 - 1);

      // Bottom half: right channel (blue)
      const barR = Math.round(rmsR * width);
      ctx.fillStyle = '#2196f3';
      ctx.fillRect(0, height / 2 + 1, barR, height / 2 - 1);

      requestAnimationFrame(draw);
    }
    draw();
  }

  // ────────────────────────────────────────────────────────────────────────
  // 10) CLEANUP ON UNLOAD
  // ────────────────────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    if (pc) pc.close();
    if (ws) ws.close();
    if (audioContext) audioContext.close();
  });

  // Helper: set audio bitrate
  function setAudioBitrate(bitrate) {
    if (!audioSender) return;
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    audioSender.setParameters(params)
      .then(() => {
        console.log(`[sports] Bitrate set to ${bitrate} bps`);
      })
      .catch(err => {
        console.error('[sports] setParameters error:', err);
      });
  }
});
