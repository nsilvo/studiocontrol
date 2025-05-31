/**
 * public/js/remote.js
 *
 * JavaScript logic for the Remote interface.
 * - Prompts for name on load
 * - Connects via WebSocket, sends join as remote
 * - Waits for 'joined' to get remoteId
 * - Waits for 'start-call' from studio, then sets up WebRTC
 * - Sends audio (mono or stereo) per instructions from studio
 * - Responds to 'mode-update', 'bitrate-update', 'mute-update', 'kick'
 * - Provides GLITS test tone toggle, local PPM meter, chat, auto-reconnect
 */

const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
let ws = null;
let remoteId = null;           // Will be assigned by server
let displayName = null;        // Entered by user

let pc = null;                 // RTCPeerConnection
let localStream = null;
let audioSender = null;
let audioCtx = null;
let analyserNode = null;
let hasLoggedBitrateChange = false; // so we only log bitrate once

// Current settings
let currentMode = 'speech';    // 'speech' or 'music'
let currentBitrate = 16000;    // in bps

// UI elements
const nameInput   = document.getElementById('name-input');
const joinBtn     = document.getElementById('join-btn');
const joinPanel   = document.getElementById('join-panel');
const mainPanel   = document.getElementById('main-panel');
const statusDiv   = document.getElementById('status');
const toneToggleBtn  = document.getElementById('tone-toggle-btn');
const muteToggleBtn  = document.getElementById('mute-toggle-btn');
const ppmCanvas   = document.getElementById('ppm-meter');
const chatBox     = document.getElementById('chat-messages');
const chatInput   = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

let isToneOn = false;
let toneOsc = null;
let toneGain = null;

// ──────── 1. JOIN FLOW ──────────────────────────────────────────────────────────

// When "Join" is clicked: prompt for name, initialize WebSocket, switch panels
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    alert('Please enter a display name.');
    return;
  }
  displayName = name;
  initializeWebSocket();
  joinPanel.classList.add('hidden');
  mainPanel.classList.remove('hidden');
  statusDiv.textContent = 'Connecting to studio...';
});

function initializeWebSocket() {
  ws = createReconnectingWebSocket(WS_URL);

  ws.onMessage(msg => {
    switch (msg.type) {
      case 'joined':
        // Server replied with our assigned remoteId
        remoteId = msg.id;
        console.log('Assigned remoteId:', remoteId);
        statusDiv.textContent = `🔑 Remote ID set. Waiting for studio to call.`;
        break;

      case 'start-call':
        // Only start WebRTC after joined
        if (!remoteId) {
          console.error('Received start-call before joined. Waiting for "joined" first.');
          return;
        }
        statusDiv.textContent = 'Starting call with studio...';
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
        alert('❌ You have been kicked by the studio.');
        ws.close();
        break;

      case 'chat':
        appendChatMessage(msg.fromId || 'Studio', msg.text);
        break;

      default:
        // Ignore "joined" here because we've already handled it,
        // and do not complain about unknown messages anymore.
        break;
    }
  });

  ws.onClose = () => {
    statusDiv.textContent = 'WebSocket closed. Reconnecting in 5 seconds...';
    console.warn('WebSocket closed. Will attempt reconnect in 5s.');
    // createReconnectingWebSocket will already attempt to reconnect,
    // so we just update the status.
  };

  // First message: tell server “I want to join as remote”
  ws.send({ type: 'join', role: 'remote', name: displayName });
}

// ──────── 2. WEBRTC CALL SETUP ─────────────────────────────────────────────────

async function startCall() {
  try {
    // 2.1 Get userMedia with correct channel count (mono=1 for speech, stereo=2 for music)
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

    // 2.2 Create RTCPeerConnection
    pc = new RTCPeerConnection(getRTCConfig());

    // 2.3 Add our audio tracks to the peer connection
    localStream.getTracks().forEach(track => {
      audioSender = pc.addTrack(track, localStream);
    });

    // 2.4 When ICE candidates are found, send them to the studio
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

    // 2.5 Create an SDP offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 2.6 Send that SDP offer to the studio
    ws.send({
      type: 'offer',
      from: remoteId,
      sdp: offer.sdp
    });

    statusDiv.textContent = 'Offer sent. Awaiting answer...';
  } catch (err) {
    console.error('Error during startCall():', err);
    statusDiv.textContent = '❌ Error starting call. See console.';
  }
}

async function handleAnswer(sdp) {
  if (!pc) {
    console.error('handleAnswer() called but RTCPeerConnection is null.');
    return;
  }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    statusDiv.textContent = '✅ Call established with studio.';
  } catch (err) {
    console.error('Error setting remote description:', err);
  }
}

async function handleCandidate(candidate) {
  if (!pc) {
    console.error('handleCandidate() called but RTCPeerConnection is null.');
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Error adding ICE candidate:', e);
  }
}

// ──────── 3. HANDLE UPDATES FROM STUDIO ────────────────────────────────────────

function handleModeUpdate(mode) {
  currentMode = mode;
  console.log(`Mode updated by studio: ${mode}`);
  statusDiv.textContent = `Mode changed to ${mode}. To apply channel change, reconnect.`;
}

async function handleBitrateUpdate(bitrate) {
  currentBitrate = bitrate;
  if (audioSender) {
    const params = audioSender.getParameters();
    if (!params.encodings || !params.encodings.length) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = bitrate;
    try {
      await audioSender.setParameters(params);
      if (!hasLoggedBitrateChange) {
        console.log(`Audio bitrate set to ${bitrate} bps`);
        hasLoggedBitrateChange = true;
      }
    } catch (e) {
      console.warn('Failed to set bitrate parameters:', e);
    }
  }
}

function handleMuteUpdate(muted) {
  if (localStream) {
    localStream.getAudioTracks().forEach(t => (t.enabled = !muted));
    statusDiv.textContent = muted
      ? '🔇 You have been muted by the studio.'
      : '🔈 You have been unmuted by the studio.';
  }
}

// ──────── 4. CHAT ─────────────────────────────────────────────────────────────

function appendChatMessage(sender, text) {
  const msgEl = document.createElement('div');
  msgEl.textContent = `[${sender}]: ${text}`;
  chatBox.appendChild(msgEl);
  chatBox.scrollTop = chatBox.scrollHeight;
}

chatSendBtn.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (!text) return;
  ws.send({
    type: 'chat',
    fromRole: 'remote',
    fromId: remoteId,
    target: 'studio',
    text
  });
  appendChatMessage('You', text);
  chatInput.value = '';
});

// ──────── 5. GLITS TEST TONE & MUTE TOGGLE ────────────────────────────────────

toneToggleBtn.addEventListener('click', () => {
  if (!audioCtx) audioCtx = new AudioContext();
  if (!isToneOn) {
    toneOsc = audioCtx.createOscillator();
    toneGain = audioCtx.createGain();
    toneOsc.frequency.value = 1000; // 1 kHz birdie tone
    toneGain.gain.value = 0.1;       // low volume
    toneOsc.connect(toneGain).connect(audioCtx.destination);
    toneOsc.start();

    // Replace microphone track with tone track in the peer connection
    if (audioSender) {
      const toneDestination = audioCtx.createMediaStreamDestination();
      const osc = audioCtx.createOscillator();
      osc.frequency.value = 1000;
      osc.connect(toneDestination);
      osc.start();
      audioSender.replaceTrack(toneDestination.stream.getAudioTracks()[0]);
    }

    toneToggleBtn.textContent = 'Stop Test Tone';
    isToneOn = true;
  } else {
    toneOsc.stop();
    toneOsc.disconnect();
    toneGain.disconnect();
    // Restore mic track
    if (localStream && audioSender) {
      audioSender.replaceTrack(localStream.getAudioTracks()[0]);
    }
    toneToggleBtn.textContent = 'Start Test Tone';
    isToneOn = false;
  }
});

muteToggleBtn.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  muteToggleBtn.textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
});

// ──────── 6. LOCAL PPM METER ──────────────────────────────────────────────────

function setupPPMMeter(stream) {
  if (!audioCtx) audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyserNode = createPPMMeter(audioCtx, source, ppmCanvas);
}

// ──────── 7. CLEANUP ON UNLOAD ────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  if (pc) pc.close();
  if (ws) ws.close();
});
