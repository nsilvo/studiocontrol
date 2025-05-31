/**
 * server.js
 *
 * Node.js signaling server for WebRTC remote audio contribution.
 * Uses CommonJS (`require`), Express for HTTP/static serving, and ws for WebSocket.
 *
 * - Serves static files from `public/`
 * - Handles WebSocket signaling between studios and remotes
 * - Implements file‐upload endpoints with multer
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3030;

// === 1) MIDDLEWARE & STATIC SERVING ===

// Only accept CORS from our domain
app.use(
  cors({
    origin: 'https://webrtc.brfm.net',
  })
);

// Serve static files under /public
app.use(express.static(path.join(__dirname, 'public')));

// === 2) RECORDINGS STORAGE & UPLOAD ===

const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir);
}

// Set up multer to store incoming files in ./recordings
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, recordingsDir);
  },
  filename: (req, file, cb) => {
    // Use original filename; caller should ensure uniqueness
    cb(null, file.originalname);
  },
});
const upload = multer({ storage });

// POST /upload → save files to ./recordings/
app.post('/upload', upload.array('files'), (req, res) => {
  const uploaded = req.files.map((f) => f.filename);
  res.json({ uploaded });
});

// GET /recordings → list all filenames in ./recordings/
app.get('/recordings', (req, res) => {
  fs.readdir(recordingsDir, (err, files) => {
    if (err) {
      console.error('Error reading recordings dir:', err);
      return res.status(500).json({ error: 'Unable to read recordings directory' });
    }
    res.json({ recordings: files });
  });
});

// Serve individual recordings statically at /recordings/<filename>
app.use(
  '/recordings',
  express.static(recordingsDir, {
    // optional: set cache headers if desired
    maxAge: '1h',
  })
);

// === 3) HTTP & WebSocket SERVER SETUP ===

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

// Maintain connected studios & remotes
// studios: Set<WebSocket>
// remotes: Map<remoteId, { ws: WebSocket, name: string }>
const studios = new Set();
const remotes = new Map();

server.on('upgrade', (request, socket, head) => {
  // Only accept WebSocket connections from our origin
  const origin = request.headers.origin;
  if (origin !== 'https://webrtc.brfm.net') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, request) => {
  // Attach custom properties to ws
  ws.isStudio = false;
  ws._remoteId = null;

  console.log('WebSocket connection from origin:', request.headers.origin);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error('Invalid JSON:', err);
      return;
    }

    const { type } = msg;

    switch (type) {
      // ---------------------------
      case 'join':
        if (msg.role === 'studio') {
          ws.isStudio = true;
          studios.add(ws);
          console.log('Studio joined. Total studios:', studios.size);
          // Send existing remotes to new studio
          remotes.forEach(({ name }, id) => {
            const newRemoteMsg = JSON.stringify({ type: 'new-remote', id, name });
            ws.send(newRemoteMsg);
          });
        } else if (msg.role === 'remote') {
          // msg.name is displayName
          const displayName = msg.name || 'Unknown';
          const remoteId = crypto.randomUUID();
          ws._remoteId = remoteId;
          remotes.set(remoteId, { ws, name: displayName });
          console.log(`Remote joined: ${displayName} (${remoteId})`);
          // Broadcast new-remote to all studios
          const payload = JSON.stringify({ type: 'new-remote', id: remoteId, name: displayName });
          studios.forEach((studioWs) => {
            if (studioWs.readyState === studioWs.OPEN) {
              studioWs.send(payload);
            }
          });
          // Inform remote of assigned ID (optional if using "joined")
          ws.send(JSON.stringify({ type: 'id-assigned', id: remoteId }));
        }
        break;

      // ---------------------------
      case 'ready-for-offer':
        // From studio → pick a remoteId
        {
          const targetId = msg.target;
          const remoteEntry = remotes.get(targetId);
          if (remoteEntry && remoteEntry.ws.readyState === remoteEntry.ws.OPEN) {
            const startCallMsg = JSON.stringify({ type: 'start-call' });
            remoteEntry.ws.send(startCallMsg);
          }
        }
        break;

      // ---------------------------
      case 'offer':
        // From remote: { type:'offer', from:remoteId, sdp }
        {
          const fromId = msg.from;
          const sdp = msg.sdp;
          const payload = JSON.stringify({ type: 'offer', from: fromId, sdp });
          studios.forEach((studioWs) => {
            if (studioWs.readyState === studioWs.OPEN) {
              studioWs.send(payload);
            }
          });
        }
        break;

      // ---------------------------
      case 'answer':
        // From studio: { type:'answer', from:'studio', target:remoteId, sdp }
        {
          const targetId = msg.target;
          const sdp = msg.sdp;
          const remoteEntry = remotes.get(targetId);
          if (remoteEntry && remoteEntry.ws.readyState === remoteEntry.ws.OPEN) {
            const payload = JSON.stringify({ type: 'answer', sdp });
            remoteEntry.ws.send(payload);
          }
        }
        break;

      // ---------------------------
      case 'candidate':
        // { type:'candidate', from:'<id>', target:'studio'|'remote', candidate }
        {
          const fromId = msg.from;
          const target = msg.target;
          const candidate = msg.candidate;

          if (target === 'studio') {
            // Broadcast to all studios
            const payload = JSON.stringify({ type: 'candidate', from: fromId, candidate });
            studios.forEach((studioWs) => {
              if (studioWs.readyState === studioWs.OPEN) {
                studioWs.send(payload);
              }
            });
          } else if (target === 'remote') {
            const targetId = msg.targetId || msg.to; // support either field
            const remoteEntry = remotes.get(targetId);
            if (remoteEntry && remoteEntry.ws.readyState === remoteEntry.ws.OPEN) {
              const payload = JSON.stringify({ type: 'candidate', candidate });
              remoteEntry.ws.send(payload);
            }
          }
        }
        break;

      // ---------------------------
      case 'mute-remote':
        // From studio: { type:'mute-remote', target:remoteId }
        {
          const targetId = msg.target;
          const remoteEntry = remotes.get(targetId);
          if (remoteEntry && remoteEntry.ws.readyState === remoteEntry.ws.OPEN) {
            const payload = JSON.stringify({ type: 'mute-update', muted: true });
            remoteEntry.ws.send(payload);
          }
        }
        break;

      // ---------------------------
      case 'kick-remote':
        // From studio: { type:'kick-remote', target:remoteId }
        {
          const targetId = msg.target;
          const remoteEntry = remotes.get(targetId);
          if (remoteEntry && remoteEntry.ws.readyState === remoteEntry.ws.OPEN) {
            const payload = JSON.stringify({ type: 'kick' });
            remoteEntry.ws.send(payload);
            remoteEntry.ws.close();
            // Removal will happen in 'close' handler
          }
        }
        break;

      // ---------------------------
      case 'mode-update':
        // From studio: { type:'mode-update', mode:'speech'|'music', target:remoteId }
        {
          const targetId = msg.target;
          const mode = msg.mode;
          const remoteEntry = remotes.get(targetId);
          if (remoteEntry && remoteEntry.ws.readyState === remoteEntry.ws.OPEN) {
            const payload = JSON.stringify({ type: 'mode-update', mode });
            remoteEntry.ws.send(payload);
          }
        }
        break;

      // ---------------------------
      case 'bitrate-update':
        // From studio: { type:'bitrate-update', bitrate:<number>, target:remoteId }
        {
          const targetId = msg.target;
          const bitrate = msg.bitrate;
          const remoteEntry = remotes.get(targetId);
          if (remoteEntry && remoteEntry.ws.readyState === remoteEntry.ws.OPEN) {
            const payload = JSON.stringify({ type: 'bitrate-update', bitrate });
            remoteEntry.ws.send(payload);
          }
        }
        break;

      // ---------------------------
      case 'mute-update':
        // From remote: { type:'mute-update', from:remoteId, target:'studio', muted:<bool> }
        // Forward to all studios so they can update UI if desired
        {
          const fromId = msg.from;
          const muted = msg.muted;
          const payload = JSON.stringify({ type: 'mute-update', from: fromId, muted });
          studios.forEach((studioWs) => {
            if (studioWs.readyState === studioWs.OPEN) {
              studioWs.send(payload);
            }
          });
        }
        break;

      // ---------------------------
      case 'chat':
        // { type:'chat', fromId:'<id>', name:'<displayName>', text:'<msg>', target:'studio'|'all' }
        {
          const text = msg.text;
          const name = msg.name || msg.fromId || 'Unknown';
          const target = msg.target;
          if (target === 'studio') {
            // Forward to all studios
            const payload = JSON.stringify({ type: 'chat', fromId: msg.fromId, name, text });
            studios.forEach((studioWs) => {
              if (studioWs.readyState === studioWs.OPEN) {
                studioWs.send(payload);
              }
            });
          } else if (target === 'all') {
            // Broadcast from studio → all remotes
            const payload = JSON.stringify({ type: 'chat', fromId: msg.fromId, name, text });
            remotes.forEach(({ ws: remoteWs }) => {
              if (remoteWs.readyState === remoteWs.OPEN) {
                remoteWs.send(payload);
              }
            });
          }
        }
        break;

      // ---------------------------
      default:
        console.warn('Unknown message type:', type);
        break;
    }
  });

  ws.on('close', () => {
    if (ws.isStudio) {
      studios.delete(ws);
      console.log('Studio disconnected. Remaining studios:', studios.size);
    } else if (ws._remoteId) {
      const rid = ws._remoteId;
      remotes.delete(rid);
      console.log(`Remote ${rid} disconnected.`);
      // Notify studios
      const payload = JSON.stringify({ type: 'remote-disconnected', id: rid });
      studios.forEach((studioWs) => {
        if (studioWs.readyState === studioWs.OPEN) {
          studioWs.send(payload);
        }
      });
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    ws.close();
  });
});

// === 4) START SERVER ===

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
