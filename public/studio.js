/**
 * studio.js (complete)
 *
 * - Manages WebSocket signaling, PeerConnections for multiple remotes.
 * - For each connected remote:
 *   • Inserts a `.remote-entry` into #remotesContainer.
 *   • Creates an AudioContext + two AnalyserNodes to meter left/right channels.
 *   • Draws those meters onto that remote’s <canvas>.
 *   • Provides “Mute” & “Kick” buttons.
 * - Cleanly removes UI & audio nodes when a remote disconnects.
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
  // peers maps peerId → { pc, entryEl, audioContext, analyserL, analyserR, rafId }
  const peers = new Map();

  // DOM references
  const connStatusSpan = document.getElementById('connStatus');
  const remotesContainer = document.getElementById('remotesContainer');
  const remoteEntryTemplate = document.getElementById('remoteEntryTemplate');

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

      case 'chat':
        // Optionally handle chat messages here
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

      // Store references so we can clean up later
      const existing = peers.get(remoteId) || {};
      peers.set(remoteId, {
        ...existing,
        pc,
        entryEl,
        audioContext,
        analyserL,
        analyserR,
        rafId: null,
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
  }

  /////////////////////////////////////////////////////
  // ENTRY POINT
  /////////////////////////////////////////////////////
  window.addEventListener('load', () => {
    initWebSocket();
  });
})();
