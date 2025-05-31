/**
 * public/js/remote.js
 * 
 * JavaScript logic for the Remote interface.
 * - Prompts for name on load
 * - Connects via WebSocket, sends join as remote
 * - Waits for 'start-call' from studio, then sets up WebRTC
 * - Sends audio (mono or stereo) per instructions from studio
 * - Responds to 'mode-update', 'bitrate-update', 'mute-update', 'kick'
 * - Provides GLITS test tone toggle, local PPM meter, chat, auto-reconnect
 */

const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
let ws;
let remoteId = null;
let displayName = null;

let pc = null;
let localStream = null;
let audioSender = null;
let audioCtx = null;
let analyserNode = null;
let meterCanvas = null;

// Current settings
let currentMode = 'speech'; // 'speech' or 'music'
let currentBitrate = 16000; // in bps

// UI elements
const container = document.getElementById('container');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const statusDiv = document.getElementById('status');
const toneToggleBtn = document.getElementById('tone-toggle-btn');
const muteToggleBtn = document.getElementById('mute-toggle-btn');
const ppmCanvas = document.getElementById('ppm-meter');
const chatBox = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

let isToneOn = false;
let toneOsc = null;
let toneGain = null;

// Prompt for name and join
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    alert('Please enter a display name.');
    return;
  }
  displayName = name;
  initializeWebSocket();
  document.getElementById('join-panel').classList.add('hidden');
  document.getElementById('main-panel').classList.remove('hidden');
  statusDiv.textContent = 'Connecting...';
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
        appendChatMessage(msg.fromRole, msg.text);
        break;
      default:
        console.warn('Remote received unknown message:', msg);
    }
  });
  ws.send({ type: 'join', role: 'remote', name: displayName });
}

// Start WebRTC call: getUserMedia, create offer, send to studio
async function startCall() {
  try {
    // Get microphone with channel count based on mode
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

    // Add audio track(s)
    localStream.getTracks().forEach(track => {
      audioSender = pc.addTrack(track, localStream);
    });

    // Handle ICE candidates
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

    // Create offer
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });
    await pc.setLocalDescription(offer);
    ws.send({ type: 'offer', from: remoteId, sdp: offer.sdp });
    statusDiv.textContent = 'Offer sent, waiting for answer...';

    // Handle remote tracks if needed (e.g., for two-way audio; not required here)

  } catch (err) {
    console.error('Error in startCall:', err);
    statusDiv.textContent = 'Error starting call.';
  }
}

async function handleAnswer(sdp) {
  if (!pc) {
    console.error('No RTCPeerConnection exists.');
    return;
  }
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
  statusDiv.textContent = 'Call established.';
}

// Handle incoming ICE candidate from studio
async function handleCandidate(candidate) {
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Error adding remote ICE candidate:', e);
    }
  }
}

// Handle mode updates (speech vs. music)
function handleModeUpdate(mode) {
  currentMode = mode;
  if (pc && audioSender) {
    // Apply channelCount constraint by renegotiating? Many browsers don't support changing channelCount on the fly.
    // Instead, we can quietly ignore or instruct user to reconnect. For simplicity, we'll log.
    console.log(`Mode changed to ${mode}. For full effect, please reconnect.`);
  }
}

// Handle bitrate updates
async function handleBitrateUpdate(bitrate) {
  currentBitrate = bitrate;
  if (audioSender) {
    const params = audioSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = bitrate;
    try {
      await audioSender.setParameters(params);
      console.log(`Updated max bitrate to ${bitrate}.`);
    } catch (e) {
      console.warn('Failed to set bitrate parameters:', e);
    }
  }
}

// Handle mute/unmute from studio
function handleMuteUpdate(muted) {
  if (localStream) {
    localStream.getAudioTracks().forEach(t => {
      t.enabled = !muted;
    });
    statusDiv.textContent = muted ? 'You have been muted.' : 'You have been unmuted.';
  }
}

// Append chat message to UI
function appendChatMessage(sender, text) {
  const msg = document.createElement('div');
  msg.textContent = `[${sender}]: ${text}`;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Chat sending
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

// GLITS test tone
toneToggleBtn.addEventListener('click', () => {
  if (!audioCtx) audioCtx = new AudioContext();
  if (!isToneOn) {
    toneOsc = audioCtx.createOscillator();
    toneGain = audioCtx.createGain();
    toneOsc.frequency.value = 1000; // 1 kHz
    toneGain.gain.value = 0.1; // lower volume
    toneOsc.connect(toneGain).connect(audioCtx.destination);
    toneOsc.start();
    // Also send tone through peer (replace mic)
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
    // Restore mic track
    if (localStream && audioSender) {
      audioSender.replaceTrack(localStream.getAudioTracks()[0]);
    }
    toneToggleBtn.textContent = 'Start Test Tone';
    isToneOn = false;
  }
});

// Mute/Unmute local mic (UI)
muteToggleBtn.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  muteToggleBtn.textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
});

// Setup local PPM meter
function setupPPMMeter(stream) {
  if (!audioCtx) audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyserNode = createPPMMeter(audioCtx, source, ppmCanvas);
}

// Auto-reconnect WebSocket: we assign a temporary remoteId once we receive it
ws = {
  send: () => {},
  close: () => {}
};

// On initial load, wait for WebSocket open to set remoteId
// But we don't know remoteId until server assigns it upon join. We'll capture it via first response.
initializeWebSocket = () => {
  ws = createReconnectingWebSocket(WS_URL);
  ws.onMessage(msg => {
    if (msg.type === 'joined') {
      remoteId = msg.id;
      console.log('Assigned remoteId:', remoteId);
    } else {
      switch (msg.type) {
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
          appendChatMessage(msg.fromRole, msg.text);
          break;
        default:
          console.warn('Remote received unknown message:', msg);
      }
    }
  });
  ws.send({ type: 'join', role: 'remote', name: displayName });
};

// Modify server to send { type: "joined", id: remoteId } back to the remote when it joins.
