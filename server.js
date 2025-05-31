/**
 * server.js
 * 
 * Node.js signaling server for WebRTC remote audio contribution system.
 * Uses Express to serve static files and Multer for file uploads.
 * Uses ws (WebSocketServer) for WebRTC signaling.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');

// Configuration
const HTTP_PORT = process.env.PORT || 3030;
const ALLOWED_ORIGIN = 'https://webrtc.brfm.net'; // Only accept WS from this origin

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

const app = express();

// CORS middleware to allow only from ALLOWED_ORIGIN for HTTP endpoints
app.use(cors({
  origin: ALLOWED_ORIGIN
}));

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Serve recordings statically at /recordings/<filename>
app.use('/recordings', express.static(recordingsDir));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, recordingsDir);
  },
  filename: (req, file, cb) => {
    // Preserve original filename; in a real system, you might sanitize or add timestamps
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

// POST /upload → accept multipart/form-data field name "files"
app.post('/upload', upload.array('files'), (req, res) => {
  // req.files is array of files
  const uploadedFilenames = req.files.map(f => f.filename);
  console.log(`Files uploaded: ${uploadedFilenames.join(', ')}`);
  res.json({ uploaded: uploadedFilenames });
});

// GET /recordings → list all files in recordings directory
app.get('/recordings', (req, res) => {
  fs.readdir(recordingsDir, (err, files) => {
    if (err) {
      console.error('Error reading recordings directory:', err);
      return res.status(500).json({ error: 'Unable to list recordings' });
    }
    // Only include regular files
    const recordings = files.filter(f => {
      const fullPath = path.join(recordingsDir, f);
      return fs.statSync(fullPath).isFile();
    });
    res.json({ recordings });
  });
});

// Create HTTP server and attach Express
const server = http.createServer(app);

// --- WebSocket (Signaling) Setup ---

// Create WebSocketServer attached to the same HTTP server
const wss = new WebSocketServer({ noServer: true });

// In-memory sets/maps to track studios and remotes
const studios = new Set(); // Set of ws for studio clients
const remotes = new Map(); // Map remoteId → { ws, name }

// Helper: broadcast a JSON message to all studios
function broadcastToStudios(message) {
  const data = JSON.stringify(message);
  studios.forEach(studioWs => {
    if (studioWs.readyState === studioWs.OPEN) {
      studioWs.send(data);
    }
  });
}

// Handle HTTP upgrade (for WebSocket)
server.on('upgrade', (request, socket, head) => {
  // Enforce WebSocket origin
  const origin = request.headers.origin;
  if (origin !== ALLOWED_ORIGIN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    console.warn(`WebSocket connection rejected from origin: ${origin}`);
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
});

// On new WebSocket connection
wss.on('connection', (ws, request) => {
  // Track whether this ws is a studio or remote (set on 'join' message)
  ws.isStudio = false;
  ws._remoteId = null; // will store remoteId if a remote

  console.log('New WebSocket connection');

  ws.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.error('Invalid JSON received:', e);
      return;
    }

    switch (msg.type) {
      case 'join':
        if (msg.role === 'studio') {
          ws.isStudio = true;
          studios.add(ws);
          console.log('Studio joined');
          // Send existing remotes to this new studio
          remotes.forEach(({ name }, id) => {
            ws.send(JSON.stringify({ type: 'new-remote', id, name }));
          });
        } else if (msg.role === 'remote') {
          // A new remote connecting
          const displayName = msg.name || 'Unknown';
          const remoteId = crypto.randomUUID();
          ws._remoteId = remoteId;
          remotes.set(remoteId, { ws, name: displayName });
          console.log(`Remote joined: ${displayName} (${remoteId})`);
          // Send remote ID back to the connecting remote
          ws.send(JSON.stringify({ type: 'joined', id: remoteId }));
          // Inform all studios about new remote
          broadcastToStudios({ type: 'new-remote', id: remoteId, name: displayName });
        }
        break;

      case 'ready-for-offer':
        // From studio; forward to specific remote
        const targetRemote = remotes.get(msg.target);
        if (targetRemote) {
          targetRemote.ws.send(JSON.stringify({ type: 'start-call' }));
        }
        break;

      case 'offer':
        // From remote → broadcast to all studios
        // msg: { type: "offer", from: "<remoteId>", sdp }
        broadcastToStudios({ type: 'offer', from: msg.from, sdp: msg.sdp });
        break;

      case 'answer':
        // From studio to remote
        // msg: { type: "answer", from: "studio", target: "<remoteId>", sdp }
        const remoteObj = remotes.get(msg.target);
        if (remoteObj) {
          remoteObj.ws.send(JSON.stringify({ type: 'answer', sdp: msg.sdp }));
        }
        break;

      case 'candidate':
        // msg: { type: "candidate", from: "<id>", target: "studio"|"remote", candidate }
        if (msg.target === 'studio') {
          // Broadcast candidate from remote or studio to studios
          broadcastToStudios({ type: 'candidate', from: msg.from, candidate: msg.candidate });
        } else if (msg.target === 'remote') {
          const dest = remotes.get(msg.to);
          if (dest) {
            dest.ws.send(JSON.stringify({ type: 'candidate', candidate: msg.candidate }));
          }
        }
        break;

      case 'mute-remote':
        // msg: { type: "mute-remote", target: "<remoteId>" }
        const muteTarget = remotes.get(msg.target);
        if (muteTarget) {
          muteTarget.ws.send(JSON.stringify({ type: 'mute-update', muted: true }));
        }
        break;

      case 'kick-remote':
        // msg: { type: "kick-remote", target: "<remoteId>" }
        const kickTarget = remotes.get(msg.target);
        if (kickTarget) {
          kickTarget.ws.send(JSON.stringify({ type: 'kick' }));
          kickTarget.ws.close();
          // will be cleaned up in 'close' handler
        }
        break;

      case 'mode-update':
        // msg: { type: "mode-update", mode: "speech"|"music", target: "<remoteId>" }
        const modeTarget = remotes.get(msg.target);
        if (modeTarget) {
          modeTarget.ws.send(JSON.stringify({ type: 'mode-update', mode: msg.mode }));
        }
        break;

      case 'bitrate-update':
        // msg: { type: "bitrate-update", bitrate: <number>, target: "<remoteId>" }
        const bitrateTarget = remotes.get(msg.target);
        if (bitrateTarget) {
          bitrateTarget.ws.send(JSON.stringify({ type: 'bitrate-update', bitrate: msg.bitrate }));
        }
        break;

      // --- Chat handling (added for live chat feature) ---
      case 'chat':
        // msg: { type: "chat", fromRole: "studio"|"remote", fromId: "<id>", target: "studio"|"remote", targetId: "<id>", text: "<message>" }
        if (msg.target === 'studio') {
          // Broadcast chat to all studios
          broadcastToStudios({ type: 'chat', fromRole: msg.fromRole, fromId: msg.fromId, text: msg.text });
        } else if (msg.target === 'remote') {
          const chatDest = remotes.get(msg.targetId);
          if (chatDest) {
            chatDest.ws.send(JSON.stringify({ type: 'chat', fromRole: msg.fromRole, fromId: msg.fromId, text: msg.text }));
          }
        }
        break;

      // --- Sports goal handling ---
      case 'goal':
        // msg: { type: "goal", fromId: "<remoteId>", team: "<teamName>" }
        // Forward to all studios
        broadcastToStudios({ type: 'goal', fromId: msg.fromId, team: msg.team });
        break;

      case 'ack-goal':
        // msg: { type: "ack-goal", targetId: "<remoteId>" }
        const ackTarget = remotes.get(msg.targetId);
        if (ackTarget) {
          ackTarget.ws.send(JSON.stringify({ type: 'ack-goal' }));
        }
        break;

      default:
        console.warn('Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    if (ws.isStudio) {
      studios.delete(ws);
      console.log('Studio disconnected');
    } else if (ws._remoteId) {
      const rid = ws._remoteId;
      remotes.delete(rid);
      console.log(`Remote disconnected: ${rid}`);
      // Notify all studios
      broadcastToStudios({ type: 'remote-disconnected', id: rid });
    }
  });

  ws.on('error', err => {
    console.error('WebSocket error:', err);
  });
});

// Start HTTP+WS server
server.listen(HTTP_PORT, () => {
  console.log(`Server listening on port ${HTTP_PORT}`);
});