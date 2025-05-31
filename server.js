// server.js

// Use CommonJS modules
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const crypto = require('crypto');

// Ensure recordings directory exists
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir);
}

const app = express();
const server = http.createServer(app);

// 1. Serve static files from "public/" (HTML, CSS, JS, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// 2. Set up Multer for file uploads into "./recordings/"
const upload = multer({ dest: recordingsDir });

// POST /upload — accept multipart/form-data field "files"
app.post('/upload', upload.array('files'), (req, res) => {
  const uploadedFiles = req.files.map(file => file.filename);
  res.json({ uploaded: uploadedFiles });
});

// GET /recordings — list all filenames in "./recordings/"
app.get('/recordings', (req, res) => {
  fs.readdir(recordingsDir, (err, files) => {
    if (err) {
      console.error('Error reading recordings directory:', err);
      return res.status(500).json({ error: 'Unable to list recordings' });
    }
    res.json({ recordings: files });
  });
});

// Serve recordings statically at "/recordings/<filename>"
app.use(
  '/recordings',
  express.static(recordingsDir, { index: false })
);

// 3. Set up WebSocket server for signaling
const wss = new WebSocket.Server({ noServer: true });
const ALLOWED_ORIGIN = 'https://webrtc.brfm.net';

// In-memory storage
const studios = new Set();           // Set<WebSocket>
const remotes = new Map();           // Map<remoteId, { ws: WebSocket, name: string }>

// Helper: broadcast a JSON message to all connected studios
function broadcastToStudios(message) {
  const json = JSON.stringify(message);
  studios.forEach(s => {
    if (s.readyState === WebSocket.OPEN) {
      s.send(json);
    }
  });
}

// 3a. Handle HTTP ⇒ WebSocket upgrade, enforcing origin check
server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin !== ALLOWED_ORIGIN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
});

// 3b. Handle new WebSocket connections
wss.on('connection', ws => {
  // Track whether this socket is a studio or a remote
  ws.isStudio = false;
  ws.isRemote = false;
  ws._remoteId = null;

  ws.on('message', messageData => {
    let msg;
    try {
      msg = JSON.parse(messageData);
    } catch (err) {
      console.error('Invalid JSON received:', err);
      return;
    }

    switch (msg.type) {
      case 'join':
        // { type: "join", role: "studio" } or { type: "join", role: "remote", name: "Alice" }
        if (msg.role === 'studio') {
          ws.isStudio = true;
          studios.add(ws);
          // Send existing remotes to this new studio
          remotes.forEach((info, rid) => {
            ws.send(JSON.stringify({ type: 'new-remote', id: rid, name: info.name }));
          });
        } else if (msg.role === 'remote') {
          const remoteId = crypto.randomUUID();
          ws.isRemote = true;
          ws._remoteId = remoteId;
          remotes.set(remoteId, { ws, name: msg.name });

          // Tell this remote its assigned ID
          ws.send(JSON.stringify({ type: 'joined', id: remoteId }));

          // Broadcast to all studios that a new remote has joined
          broadcastToStudios({ type: 'new-remote', id: remoteId, name: msg.name });
        }
        break;

      case 'ready-for-offer':
        // { type: "ready-for-offer", target: "<remoteId>" }
        {
          const targetId = msg.target;
          const remoteInfo = remotes.get(targetId);
          if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
            remoteInfo.ws.send(JSON.stringify({ type: 'start-call' }));
          }
        }
        break;

      case 'offer':
        // { type: "offer", from: "<remoteId>", sdp: "<sdp>" }
        broadcastToStudios({ type: 'offer', from: msg.from, sdp: msg.sdp });
        break;

      case 'answer':
        // { type: "answer", from: "studio", target: "<remoteId>", sdp: "<sdp>" }
        {
          const targetId = msg.target;
          const remoteInfo = remotes.get(targetId);
          if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
            remoteInfo.ws.send(JSON.stringify({ type: 'answer', sdp: msg.sdp }));
          }
        }
        break;

      case 'candidate':
        // { type: "candidate", from: "<id>", target: "studio"|"remote", candidate: {...}, to?: "<remoteId>" }
        {
          const fromId = msg.from;
          const candidate = msg.candidate;
          if (msg.target === 'studio') {
            broadcastToStudios({ type: 'candidate', from: fromId, candidate });
          } else if (msg.target === 'remote') {
            const targetId = msg.to;
            const remoteInfo = remotes.get(targetId);
            if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
              remoteInfo.ws.send(JSON.stringify({ type: 'candidate', candidate }));
            }
          }
        }
        break;

      case 'mute-remote':
        // { type: "mute-remote", target: "<remoteId>" }
        {
          const targetId = msg.target;
          const remoteInfo = remotes.get(targetId);
          if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
            remoteInfo.ws.send(JSON.stringify({ type: 'mute-update', muted: true }));
          }
        }
        break;

      case 'kick-remote':
        // { type: "kick-remote", target: "<remoteId>" }
        {
          const targetId = msg.target;
          const remoteInfo = remotes.get(targetId);
          if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
            remoteInfo.ws.send(JSON.stringify({ type: 'kick' }));
            remoteInfo.ws.close();
          }
        }
        break;

      case 'mode-update':
        // { type: "mode-update", mode: "speech"|"music", target: "<remoteId>" }
        {
          const targetId = msg.target;
          const remoteInfo = remotes.get(targetId);
          if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
            remoteInfo.ws.send(JSON.stringify({ type: 'mode-update', mode: msg.mode }));
          }
        }
        break;

      case 'bitrate-update':
        // { type: "bitrate-update", bitrate: <number>, target: "<remoteId>" }
        {
          const targetId = msg.target;
          const remoteInfo = remotes.get(targetId);
          if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
            remoteInfo.ws.send(JSON.stringify({ type: 'bitrate-update', bitrate: msg.bitrate }));
          }
        }
        break;

      case 'chat':
        // { type: "chat", fromRole: "studio"|"remote", fromId: "<id>", target: "studio"|"remote", targetId?: "<remoteId>", text: "<message>" }
        {
          const fromRole = msg.fromRole;
          const fromId = msg.fromId;
          const text = msg.text;
          if (msg.target === 'studio') {
            // Broadcast chat to all studios
            broadcastToStudios({ type: 'chat', fromRole, fromId, text });
          } else if (msg.target === 'remote') {
            const targetId = msg.targetId;
            const remoteInfo = remotes.get(targetId);
            if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
              remoteInfo.ws.send(JSON.stringify({ type: 'chat', fromRole, fromId, text }));
            }
          }
        }
        break;

      case 'goal':
        // { type: "goal", fromId: "<remoteId>", team: "<teamName>" }
        broadcastToStudios({ type: 'goal', fromId: msg.fromId, team: msg.team });
        break;

      case 'ack-goal':
        // { type: "ack-goal", targetId: "<remoteId>" }
        {
          const targetId = msg.targetId;
          const remoteInfo = remotes.get(targetId);
          if (remoteInfo && remoteInfo.ws.readyState === WebSocket.OPEN) {
            remoteInfo.ws.send(JSON.stringify({ type: 'ack-goal' }));
          }
        }
        break;

      default:
        console.warn('Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    if (ws.isRemote) {
      // Clean up remote on disconnect
      const rid = ws._remoteId;
      if (rid && remotes.has(rid)) {
        remotes.delete(rid);
        broadcastToStudios({ type: 'remote-disconnected', id: rid });
      }
    }
    if (ws.isStudio) {
      studios.delete(ws);
    }
  });

  ws.on('error', err => {
    console.error('WebSocket error:', err);
  });
});

const PORT = 3030;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
