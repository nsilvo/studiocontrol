/**
 * sports.js
 *
 * Front-end logic for a sports reporter (v1).
 * - Extends remote.js functionality with:
 *   • Reporter name, team names, scoreboard controls
 *   • “Goal!” button → notifies studio, which flashes remote red
 *   • Local “Start Segment”/“Stop Segment” recording → sends blob to studio for playback
 *   • Retains remote audio controls (mute, tone, listen, bitrate)
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
  let pc = null;
  let localStream = null;
  let audioSender = null;
  let localID = null;
  let reporterName = '';
  let teamA = '';
  let teamB = '';
  let isMuted = false;
  let isTone = false;
  let toneOscillator = null;
  let toneContext = null;
  let toneDestination = null;
  let toneTimer = null;

  // UI elements
  const setupSection = document.getElementById('setup-section');
  const reporterNameInput = document.getElementById('reporterNameInput');
  const teamAInput = document.getElementById('teamAInput');
  const teamBInput = document.getElementById('teamBInput');
  const connectBtn = document.getElementById('connectBtn');

  const sportsUI = document.getElementById('sports-ui');
  const muteSelfBtn = document.getElementById('muteSelfBtn');
  const toneBtn = document.getElementById('toneBtn');
  const listenStudioBtn = document.getElementById('listenStudioBtn');
  const connStatusSpan = document.getElementById('connStatus');
  const meterCanvas = document.getElementById('meter-canvas');
  const meterContext = meterCanvas.getContext('2d');

  const bitrateSelector = document.getElementById('bitrateSelector');

  // Scoreboard & Goal
  const scoreAInput = document.getElementById('scoreAInput');
  const scoreBInput = document.getElementById('scoreBInput');
  const updateScoreBtn = document.getElementById('updateScoreBtn');
  const goalBtn = document.getElementById('goalBtn');

  // Recording controls
  const startSegmentBtn = document.getElementById('startSegmentBtn');
  const stopSegmentBtn = document.getElementById('stopSegmentBtn');
  const segmentPlayerContainer = document.getElementById('segmentPlayerContainer');

  // Chat
  const studioMuteStatus = document.getElementById('studioMuteStatus');
  const chatWindowEl = document.getElementById('chatWindow');
  const chatInputEl = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  // Hidden audio element for incoming studio audio
  const audioStudioElem = document.getElementById('audio-studio');

  let audioContext = null;
  let analyserL = null;
  let analyserR = null;

  // Recording variables
  let segmentRecorder = null;
  let recordedSegmentBlobs = [];
  let isRecording = false;

  /////////////////////////////////////////////////////
  // Initialize WebSocket & event listeners
  /////////////////////////////////////////////////////
  function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
      console.log('WebSocket connected (sports).');
      // Send join with reporter name + teams
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'sports',
          name: reporterName,
          teamA,
          teamB,
        })
      );
    };
    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (err) {
        console.error('Invalid JSON from server:', err);
        return;
      }
      handleSignalingMessage(msg);
    };
    ws.onclose = () => {
      console.warn('WebSocket closed. Reconnecting in 5 seconds...');
      connStatusSpan.textContent = 'disconnected';
      setTimeout(initWebSocket, 5000);
      if (pc) {
        pc.close();
        pc = null;
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
      case 'id-assigned':
        // { type:'id-assigned', id }
        localID = msg.id;
        console.log('Assigned localID:', localID);
        connStatusSpan.textContent = 'waiting';
        break;

      case 'start-call':
        connStatusSpan.textContent = 'connecting...';
        await startWebRTC();
        break;

      case 'answer':
        await handleAnswer(msg.sdp);
        break;

      case 'candidate':
        await handleCandidate(msg.candidate);
        break;

      case 'studio-disconnected':
        console.warn('Studio disconnected.');
        connStatusSpan.textContent = 'studio disconnected';
        break;

      case 'mute-update':
        handleMuteUpdate(msg.muted);
        break;

      case 'kicked':
        alert(`You have been disconnected by the studio:\n\n${msg.reason}`);
        ws.close();
        connStatusSpan.textContent = 'kicked';
        break;

      case 'chat':
        appendChatMessage(msg.name, msg.message, msg.from === localID);
        break;

      case 'score-update':
        // { type:'score-update', teamA, teamB, scoreA, scoreB }
        alert(`Score Update:\n${msg.teamA} ${msg.scoreA} - ${msg.scoreB} ${msg.teamB}`);
        break;

      case 'goal':
        // { type:'goal', from }
        if (msg.from === localID) return; // Ignore my own event
        flashRedForGoal(msg.from);
        break;

      case 'reporter-recording':
        // { type:'reporter-recording', from, name, data (base64) }
        displaySegmentOnStudio(msg);
        break;

      default:
        console.warn('Unknown signaling message (sports):', msg.type);
    }
  }

  /////////////////////////////////////////////////////
  // Start WebRTC (getUserMedia, createOffer, send to studio)
  /////////////////////////////////////////////////////
  async function startWebRTC() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 2,
        },
      });
    } catch (err) {
      console.error('getUserMedia error:', err);
      connStatusSpan.textContent = 'mic error';
      return;
    }

    pc = new RTCPeerConnection(ICE_CONFIG);

    // Add mic track (remote → studio)
    const track = localStream.getAudioTracks()[0];
    audioSender = pc.addTrack(track, localStream);

    // Set initial bitrate
    setAudioBitrate(parseInt(bitrateSelector.value, 10));
    bitrateSelector.onchange = () => {
      const br = parseInt(bitrateSelector.value, 10);
      setAudioBitrate(br);
    };

    setupLocalMeter(localStream);

    pc.ontrack = (evt) => {
      const [incomingStream] = evt.streams;
      if (!audioStudioElem.srcObject) {
        audioStudioElem.srcObject = incomingStream;
      }
    };

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        ws.send(
          JSON.stringify({
            type: 'candidate',
            from: localID,
            target: 'studio',
            candidate: evt.candidate,
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      connStatusSpan.textContent = state;
      console.log('Connection state:', state);
    };

    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error('createOffer error:', err);
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'offer',
        from: localID,
        sdp: pc.localDescription.sdp,
      })
    );
  }

  /////////////////////////////////////////////////////
  // Handle answer from studio
  /////////////////////////////////////////////////////
  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      console.log('Remote description (answer) set');
    } catch (err) {
      console.error('setRemoteDescription error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Handle ICE candidate from studio
  /////////////////////////////////////////////////////
  async function handleCandidate(candidate) {
    if (!pc || !pc.remoteDescription) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('addIceCandidate error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Handle mute-update
  /////////////////////////////////////////////////////
  function handleMuteUpdate(muted) {
    studioMuteStatus.textContent = muted
      ? '🔇 You have been muted by the studio.'
      : '🎙️ Studio is unmuted.';
  }

  /////////////////////////////////////////////////////
  // Local audio meter
  /////////////////////////////////////////////////////
  function setupLocalMeter(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const source = audioContext.createMediaStreamSource(stream);
    const splitter = audioContext.createChannelSplitter(2);

    analyserL = audioContext.createAnalyser();
    analyserL.fftSize = 256;
    analyserR = audioContext.createAnalyser();
    analyserR.fftSize = 256;

    source.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    drawLocalMeter();
  }

  function drawLocalMeter() {
    if (!analyserL || !analyserR) return;

    const bufferLength = analyserL.frequencyBinCount;
    const dataArrayL = new Uint8Array(bufferLength);
    const dataArrayR = new Uint8Array(bufferLength);

    function draw() {
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

      meterContext.clearRect(0, 0, meterCanvas.width, meterCanvas.height);

      meterContext.fillStyle = '#4caf50';
      const widthL = Math.round(rmsL * meterCanvas.width);
      meterContext.fillRect(0, 0, widthL, meterCanvas.height / 2 - 1);

      meterContext.fillStyle = '#2196f3';
      const widthR = Math.round(rmsR * meterCanvas.width);
      meterContext.fillRect(0, meterCanvas.height / 2 + 1, widthR, meterCanvas.height / 2 - 1);

      requestAnimationFrame(draw);
    }
    draw();
  }

  /////////////////////////////////////////////////////
  // Set audio bitrate on RTCRtpSender
  /////////////////////////////////////////////////////
  async function setAudioBitrate(bitrate) {
    if (!audioSender) return;
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings.forEach((enc) => {
      enc.maxBitrate = bitrate;
    });
    try {
      await audioSender.setParameters(params);
      console.log(`Audio bitrate set to ${bitrate} bps`);
    } catch (err) {
      console.error('setParameters error:', err);
    }
  }

  /////////////////////////////////////////////////////
  // Toggle mute/unmute (remote → studio)
  /////////////////////////////////////////////////////
  function toggleMute() {
    if (!audioSender) return;
    isMuted = !isMuted;
    const track = isMuted ? null : localStream.getAudioTracks()[0];
    audioSender.replaceTrack(track);

    ws.send(
      JSON.stringify({
        type: 'mute-update',
        from: localID,
        target: 'studio',
        muted: isMuted,
      })
    );

    muteSelfBtn.textContent = isMuted ? 'Unmute Myself' : 'Mute Myself';
  }

  /////////////////////////////////////////////////////
  // Toggle listen to studio audio
  /////////////////////////////////////////////////////
  function toggleListenStudio() {
    if (!audioStudioElem.srcObject) {
      alert('You are not yet connected to studio audio.');
      return;
    }
    audioStudioElem.muted = !audioStudioElem.muted;
    listenStudioBtn.textContent = audioStudioElem.muted
      ? 'Listen to Studio'
      : 'Mute Studio Audio';
  }

  /////////////////////////////////////////////////////
  // Toggle sending a GLITS tone
  /////////////////////////////////////////////////////
  function toggleTone() {
    if (!audioSender) return;

    if (!isTone) {
      toneContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      toneDestination = toneContext.createMediaStreamDestination();

      toneOscillator = toneContext.createOscillator();
      toneOscillator.type = 'sine';
      toneOscillator.frequency.setValueAtTime(400, toneContext.currentTime);
      toneOscillator.connect(toneDestination);
      toneOscillator.start();

      const toneTrack = toneDestination.stream.getAudioTracks()[0];
      audioSender.replaceTrack(toneTrack);

      let currentFreq = 400;
      toneTimer = setInterval(() => {
        currentFreq = currentFreq === 400 ? 1000 : 400;
        toneOscillator.frequency.setValueAtTime(currentFreq, toneContext.currentTime);
      }, 1000);

      setupLocalMeter(toneDestination.stream);

      isTone = true;
      toneBtn.textContent = 'Stop GLITS Tone';
    } else {
      clearInterval(toneTimer);
      toneOscillator.stop();
      toneOscillator.disconnect();
      toneDestination.disconnect();

      const micTrack = localStream.getAudioTracks()[0];
      audioSender.replaceTrack(micTrack);
      setupLocalMeter(localStream);

      isTone = false;
      toneBtn.textContent = 'Send GLITS Tone';
    }
  }

  /////////////////////////////////////////////////////
  // CHAT: append message
  /////////////////////////////////////////////////////
  function appendChatMessage(senderName, message, isLocal) {
    const div = document.createElement('div');
    div.className = 'chat-message';
    if (isLocal) {
      div.innerHTML = `<strong>You:</strong> ${message}`;
    } else {
      div.innerHTML = `<strong>${senderName}:</strong> ${message}`;
    }
    chatWindowEl.appendChild(div);
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  }

  /////////////////////////////////////////////////////
  // UPDATE SCORE
  /////////////////////////////////////////////////////
  function sendScoreUpdate() {
    const sA = parseInt(scoreAInput.value, 10);
    const sB = parseInt(scoreBInput.value, 10);
    ws.send(
      JSON.stringify({
        type: 'score-update',
        from: localID,
        teamA,
        teamB,
        scoreA: sA,
        scoreB: sB,
      })
    );
  }

  /////////////////////////////////////////////////////
  // SEND GOAL EVENT
  /////////////////////////////////////////////////////
  function sendGoal() {
    ws.send(
      JSON.stringify({
        type: 'goal',
        from: localID,
      })
    );
    // Optionally flash local indicator or disable button for 20s?
    goalBtn.disabled = true;
    setTimeout(() => {
      goalBtn.disabled = false;
    }, 20000);
  }

  /////////////////////////////////////////////////////
  // FLASH RED FOR 20s ON SCREEN
  /////////////////////////////////////////////////////
  function flashRedForGoal(fromID) {
    // Find the element representing that remote in the studio UI (id="connected-<fromID>")
    const li = document.getElementById(`connected-${fromID}`);
    if (!li) return;
    li.style.backgroundColor = '#ff4d4d';
    // Append an “Accept” button if not already present
    if (!li.querySelector('.accept-goal-btn')) {
      const acceptBtn = document.createElement('button');
      acceptBtn.textContent = 'Accept Goal';
      acceptBtn.className = 'accept-goal-btn';
      acceptBtn.style.marginLeft = '10px';
      acceptBtn.onclick = () => {
        li.style.backgroundColor = ''; // clear flash
        acceptBtn.remove();
      };
      li.appendChild(acceptBtn);
    }
    // Automatically clear after 20 seconds if not accepted
    setTimeout(() => {
      li.style.backgroundColor = '';
      const acc = li.querySelector('.accept-goal-btn');
      if (acc) acc.remove();
    }, 20000);
  }

  /////////////////////////////////////////////////////
  // START LOCAL SEGMENT RECORDING
  /////////////////////////////////////////////////////
  function startSegmentRecording() {
    if (!localStream) {
      alert('Not yet connected.');
      return;
    }
    if (isRecording) return;
    isRecording = true;
    startSegmentBtn.disabled = true;
    stopSegmentBtn.disabled = false;
    recordedSegmentBlobs = [];

    segmentRecorder = new MediaRecorder(localStream, { mimeType: 'audio/webm' });
    segmentRecorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) {
        recordedSegmentBlobs.push(evt.data);
      }
    };
    segmentRecorder.onstop = sendSegmentToStudio;
    segmentRecorder.start();
  }

  /////////////////////////////////////////////////////
  // STOP RECORDING & SEND TO STUDIO
  /////////////////////////////////////////////////////
  function stopSegmentRecording() {
    if (!segmentRecorder || !isRecording) return;
    segmentRecorder.stop();
    isRecording = false;
    startSegmentBtn.disabled = false;
    stopSegmentBtn.disabled = true;
  }

  /////////////////////////////////////////////////////
  // SEND SEGMENT (base64) TO STUDIO FOR PLAYBACK
  /////////////////////////////////////////////////////
  function sendSegmentToStudio() {
    const blob = new Blob(recordedSegmentBlobs, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64Data = reader.result.split(',')[1]; // Strip “data:audio/webm;base64,”
      ws.send(
        JSON.stringify({
          type: 'reporter-recording',
          from: localID,
          name: reporterName,
          data: base64Data,
        })
      );
      // Optional: show local playback
      const audioURL = URL.createObjectURL(blob);
      segmentPlayerContainer.innerHTML = `
        <p>Recorded Segment:</p>
        <audio controls src="${audioURL}"></audio>
      `;
    };
    reader.readAsDataURL(blob);
  }

  /////////////////////////////////////////////////////
  // HANDLE INCOMING “reporter-recording” ON STUDIO SIDE
  /////////////////////////////////////////////////////
  function displaySegmentOnStudio(msg) {
    // msg: { type, from, name, data }
    // The studio will decode base64 and add an <audio> link in the appropriate remote’s UI.
    // This function is here as a placeholder: Real implementation lives in /studio.js
    console.log('Studio should implement displaySegmentOnStudio()');
  }

  /////////////////////////////////////////////////////
  // EVENT LISTENERS
  /////////////////////////////////////////////////////
  connectBtn.onclick = () => {
    reporterName = reporterNameInput.value.trim();
    teamA = teamAInput.value.trim();
    teamB = teamBInput.value.trim();
    if (!reporterName || !teamA || !teamB) {
      alert('Please fill in Reporter Name, Team A, and Team B.');
      return;
    }
    setupSection.style.display = 'none';
    sportsUI.style.display = 'block';
    connStatusSpan.textContent = 'connecting...';
    initWebSocket();
  };

  muteSelfBtn.onclick = toggleMute;
  toneBtn.onclick = toggleTone;
  listenStudioBtn.onclick = toggleListenStudio;

  sendChatBtn.onclick = () => {
    const text = chatInputEl.value.trim();
    if (!text) return;
    ws.send(
      JSON.stringify({
        type: 'chat',
        from: localID,
        name: reporterName,
        message: text,
        target: 'studio',
      })
    );
    appendChatMessage('You', text, true);
    chatInputEl.value = '';
  };

  updateScoreBtn.onclick = sendScoreUpdate;
  goalBtn.onclick = sendGoal;

  startSegmentBtn.onclick = startSegmentRecording;
  stopSegmentBtn.onclick = stopSegmentRecording;

  /////////////////////////////////////////////////////
  // Initialization on page load
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    // Nothing until Connect is clicked
  });
})();
