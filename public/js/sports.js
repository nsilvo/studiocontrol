/**
 * public/js/sports.js
 * 
 * JavaScript logic for the Sports remote interface.
 * Extends remote.js with:
 *  - Reporter name, team names prompt
 *  - Score entry fields
 *  - Goal button → flash notification to studio
 *  - Local segment recording (record segments on demand)
 */

const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
let ws;
let remoteId = null;
let reporterName = null;
let teamA = null;
let teamB = null;

let pc = null;
let localStream = null;
let audioSender = null;
let audioCtx = null;
let analyserNode = null;
let meterCanvas = null;

// Current settings
let currentMode = 'speech';
let currentBitrate = 16000;

// UI elements
const container = document.getElementById('container');
const joinPanel = document.getElementById('join-panel');
const mainPanel = document.getElementById('main-panel');
const statusDiv = document.getElementById('status');

const scoreAInput = document.getElementById('scoreA');
const scoreBInput = document.getElementById('scoreB');
const goalBtn = document.getElementById('goal-btn');

const toneToggleBtn = document.getElementById('tone-toggle-btn');
const muteToggleBtn = document.getElementById('mute-toggle-btn');
const ppmCanvas = document.getElementById('ppm-meter');

const chatBox = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

const segmentsContainer = document.getElementById('segments-container');
const segmentList = document.getElementById('segments-list');
const startSegmentBtn = document.getElementById('start-segment-btn');
const stopSegmentBtn = document.getElementById('stop-segment-btn');

let isToneOn = false;
let toneOsc = null;
let toneGain = null;

// Segment recording
let segmentRecorder = null;
let segmentChunks = [];

// Prompt for reporter & teams
joinPanel.querySelector('#reporter-input-btn').addEventListener('click', () => {
  reporterName = document.getElementById('reporter-input').value.trim();
  teamA = document.getElementById('teamA-input').value.trim();
  teamB = document.getElementById('teamB-input').value.trim();
  if (!reporterName || !teamA || !teamB) {
    alert('Please enter reporter name and both team names.');
    return;
  }
  initializeWebSocket();
  joinPanel.classList.add('hidden');
  mainPanel.classList.remove('hidden');
  statusDiv.textContent = `Waiting for call as ${reporterName} for ${teamA} vs ${teamB}...`;
});

function initializeWebSocket() {
  ws = createReconnectingWebSocket(WS_URL);
  ws.onMessage(msg => {
    switch (msg.type) {
      case 'joined':
        remoteId = msg.id;
        console.log('Assigned remoteId:', remoteId);
        break;
      case 'start-call':
        statusDiv.textContent = 'Starting call...';
        startCall();
        break;
      case 'answer':
        handleAnswer(msg.sdp);
        break;
      case 'candidate':
        handleCandidate(msg.candidate);
        break;
      case 'mode-update':
        handleModeUpdate(msg.mode);
        break;
      case 'bitrate-update':
        handleBitrateUpdate(msg.bitrate);
        break;
      case 'mute-update':
        handleMuteUpdate(msg.muted);
        break;
      case 'kick':
        alert('You have been kicked by the studio.');
        ws.close();
        break;
      case 'chat':
        appendChatMessage('Studio', msg.text);
        break;
      case 'ack-goal':
        clearGoalFlash();
        break;
      default:
        console.warn('Sports remote received unknown message:', msg);
    }
  });
  ws.send({
    type: 'join',
    role: 'remote',
    name: reporterName,
    teamA,
    teamB,
    isSports: true
  });
}

// Start WebRTC call
async function startCall() {
  try {
    const constraints = {
      audio: {
        channelCount: currentMode === 'music' ? 2 : 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true
      }
    };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    setupPPMMeter(localStream);

    pc = new RTCPeerConnection(getRTCConfig());
    localStream.getTracks().forEach(track => {
      audioSender = pc.addTrack(track, localStream);
    });

    pc.onicecandidate = event => {
      if (event.candidate) {
        ws.send({
          type: 'candidate',
          from: remoteId,
          target: 'studio',
          candidate: event.candidate
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send({ type: 'offer', from: remoteId, sdp: offer.sdp });
    statusDiv.textContent = 'Offer sent, waiting for answer...';
  } catch (err) {
    console.error('Error in startCall:', err);
    statusDiv.textContent = 'Error starting call.';
  }
}

async function handleAnswer(sdp) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
  statusDiv.textContent = 'Call established.';
}

async function handleCandidate(candidate) {
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Error adding ICE candidate:', e);
    }
  }
}

function handleModeUpdate(mode) {
  currentMode = mode;
  console.log(`Mode changed to ${mode}. Reconnect for best effect.`);
}

async function handleBitrateUpdate(bitrate) {
  currentBitrate = bitrate;
  if (audioSender) {
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    try {
      await audioSender.setParameters(params);
      console.log(`Bitrate updated to ${bitrate}`);
    } catch (e) {
      console.warn('Failed to set bitrate:', e);
    }
  }
}

function handleMuteUpdate(muted) {
  if (localStream) {
    localStream.getAudioTracks().forEach(t => {
      t.enabled = !muted;
    });
    statusDiv.textContent = muted ? 'You have been muted.' : 'You have been unmuted.';
  }
}

// Append chat message
function appendChatMessage(sender, text) {
  const msg = document.createElement('div');
  msg.textContent = `[${sender}]: ${text}`;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Send chat
chatSendBtn.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (!text) return;
  ws.send({ type: 'chat', fromRole: 'remote', fromId: remoteId, target: 'studio', text });
  appendChatMessage('You', text);
  chatInput.value = '';
});

// GLITS test tone
toneToggleBtn.addEventListener('click', () => {
  if (!audioCtx) audioCtx = new AudioContext();
  if (!isToneOn) {
    toneOsc = audioCtx.createOscillator();
    toneGain = audioCtx.createGain();
    toneOsc.frequency.value = 1000;
    toneGain.gain.value = 0.1;
    toneOsc.connect(toneGain).connect(audioCtx.destination);
    toneOsc.start();
    if (audioSender) {
      const toneStream = audioCtx.createMediaStreamDestination();
      const osc = audioCtx.createOscillator();
      osc.frequency.value = 1000;
      osc.connect(toneStream);
      osc.start();
      audioSender.replaceTrack(toneStream.stream.getAudioTracks()[0]);
    }
    toneToggleBtn.textContent = 'Stop Test Tone';
    isToneOn = true;
  } else {
    toneOsc.stop();
    toneOsc.disconnect();
    toneGain.disconnect();
    if (localStream && audioSender) {
      audioSender.replaceTrack(localStream.getAudioTracks()[0]);
    }
    toneToggleBtn.textContent = 'Start Test Tone';
    isToneOn = false;
  }
});

// Mute/unmute
muteToggleBtn.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  muteToggleBtn.textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
});

// Setup PPM meter
function setupPPMMeter(stream) {
  if (!audioCtx) audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyserNode = createPPMMeter(audioCtx, source, ppmCanvas);
}

// Goal button
goalBtn.addEventListener('click', () => {
  const scoreA = parseInt(scoreAInput.value) || 0;
  const scoreB = parseInt(scoreBInput.value) || 0;
  const leadingTeam = scoreA > scoreB ? teamA : teamB;
  ws.send({ type: 'goal', fromId: remoteId, team: leadingTeam });
  flashGoalAlert();
});

// Flash notification until ack
function flashGoalAlert() {
  container.style.boxShadow = '0 0 20px 5px red';
}

function clearGoalFlash() {
  container.style.boxShadow = '';
}

// Local segment recording
startSegmentBtn.addEventListener('click', () => {
  if (!localStream) {
    alert('No audio stream to record.');
    return;
  }
  segmentRecorder = new MediaRecorder(localStream, { mimeType: 'audio/webm' });
  segmentChunks = [];
  segmentRecorder.ondataavailable = e => {
    if (e.data.size > 0) segmentChunks.push(e.data);
  };
  segmentRecorder.onstop = () => {
    const blob = new Blob(segmentChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const li = document.createElement('li');
    li.className = 'segment-item';
    li.textContent = `Segment ${new Date().toLocaleTimeString()}`;
    const playBtn = document.createElement('button');
    playBtn.textContent = 'Play';
    playBtn.onclick = () => {
      const audio = new Audio(url);
      audio.play();
    };
    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download';
    downloadBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = `segment-${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 100);
    };
    li.appendChild(playBtn);
    li.appendChild(downloadBtn);
    segmentList.appendChild(li);
  };
  segmentRecorder.start();
  alert('Segment recording started.');
});

stopSegmentBtn.addEventListener('click', () => {
  if (segmentRecorder && segmentRecorder.state !== 'inactive') {
    segmentRecorder.stop();
    alert('Segment recording stopped.');
  }
});

// Clean up on unload
window.addEventListener('beforeunload', () => {
  if (pc) pc.close();
  if (ws) ws.close();
});