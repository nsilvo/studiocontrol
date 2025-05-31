/**
 * server.js (CommonJS)
 *
 * - WebSocket signaling server (using ws) on top of an Express app.
 * - Serves static files (studio.html, remote.html, recordings.html, etc.).
 * - Accepts uploads (multipart/form-data) at POST /upload and saves them under ./recordings/.
 * - Exposes GET /recordings to return a JSON list of stored recordings.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const cors = require('cors');

// Use __dirname directly (CommonJS)
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, recordingsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/\s+/g, '_');
    cb(null, `${timestamp}_${safeName}`);
  },
});
const upload = multer({ storage });

// Express app
const app = express();
app.use(cors());

// Serve static frontend files from "public" directory
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// POST /upload – accept multipart files (field name "files")
app.post('/upload', upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }
  const savedFiles = req.files.map((f) => f.filename);
  return res.json({ uploaded: savedFiles });
});

// GET /recordings – list all files in recordings directory
app.get('/recordings', (req, res) => {
  fs.readdir(recordingsDir, (err, files) => {
    if (err) {
      console.error('Error reading recordings directory:', err);
      return res.status(500).json({ error: 'Could not list recordings.' });
    }
    return res.json({ recordings: files });
  });
});

// Serve individual recording files under /recordings/*
app.use('/recordings', express.static(recordingsDir));

// Create HTTP server and bind Express
const server = http.createServer(app);

// WebSocket server (ws) attaches to the same HTTP server
const wss = new WebSocketServer({ server });

// In‐memory store of connected clients
const studios = new Set();
const remotes = new Map(); // remoteId → { ws, name }

// Broadcast to all studios
function broadcastToStudios(obj) {
  const msg = JSON.stringify(obj);
  studios.forEach((clientWs) => {
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.send(msg);
    }
  });
}

// Send to a specific client
function sendToClient(clientWs, obj) {
  if (clientWs.readyState === clientWs.OPEN) {
    clientWs.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws, req) => {
  // Only accept origin from https://webrtc.brfm.net
  const origin = req.headers.origin;
  if (origin !== 'https://webrtc.brfm.net') {
    ws.close();
    console.warn('Connection from disallowed origin:', origin);
    return;
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      console.error('Invalid JSON:', err);
      return;
    }

    switch (msg.type) {
      case 'join':
        // { type:'join', role:'studio'|'remote', name? }
        if (msg.role === 'studio') {
          studios.add(ws);
          console.log('Studio joined.');
          // Send existing remotes to this studio
          remotes.forEach(({ name }, remoteId) => {
            sendToClient(ws, {
              type: 'new-remote',
              id: remoteId,
              name,
            });
          });
        } else if (msg.role === 'remote') {
          const remoteId = msg.id || require('crypto').randomUUID();
          remotes.set(remoteId, { ws, name: msg.name });
          console.log(`Remote joined: ${msg.name} (${remoteId})`);
          broadcastToStudios({
            type: 'new-remote',
            id: remoteId,
            name: msg.name,
          });
          ws._remoteId = remoteId;
        }
        break;

      case 'ready-for-offer':
        // { type:'ready-for-offer', target:<remoteId> }
        {
          const rData = remotes.get(msg.target);
          if (rData) {
            sendToClient(rData.ws, { type: 'start-call' });
          }
        }
        break;

      case 'offer':
        // { type:'offer', from:'<remoteId>', sdp }
        broadcastToStudios({
          type: 'offer',
          from: msg.from,
          sdp: msg.sdp,
        });
        break;

      case 'answer':
        // { type:'answer', from:'studio', target:'<remoteId>', sdp }
        {
          const rData = remotes.get(msg.target);
          if (rData) {
            sendToClient(rData.ws, {
              type: 'answer',
              sdp: msg.sdp,
            });
          }
        }
        break;

      case 'candidate':
        // { type:'candidate', from:'<id>', target:'studio'|'remote', candidate }
        if (msg.target === 'studio') {
          broadcastToStudios({
            type: 'candidate',
            from: msg.from,
            candidate: msg.candidate,
          });
        } else if (msg.target === 'remote') {
          const rData = remotes.get(msg.to);
          if (rData) {
            sendToClient(rData.ws, {
              type: 'candidate',
              candidate: msg.candidate,
            });
          }
        }
        break;

      case 'mute-remote':
        // { type:'mute-remote', target:'<remoteId>' }
        {
          const rData = remotes.get(msg.target);
          if (rData) {
            sendToClient(rData.ws, {
              type: 'mute-update',
              muted: true,
            });
          }
        }
        break;

      case 'kick-remote':
        // { type:'kick-remote', target:'<remoteId>' }
        {
          const rData = remotes.get(msg.target);
          if (rData) {
            sendToClient(rData.ws, { type: 'kick' });
            rData.ws.close();
          }
        }
        break;

      case 'mode-update':
        // { type:'mode-update', mode:'speech'|'music', target:'<remoteId>' }
        {
          const rData = remotes.get(msg.target);
          if (rData) {
            sendToClient(rData.ws, {
              type: 'mode-update',
              mode: msg.mode,
            });
          }
        }
        break;

      case 'bitrate-update':
        // { type:'bitrate-update', bitrate:<number>, target:'<remoteId>' }
        {
          const rData = remotes.get(msg.target);
          if (rData) {
            sendToClient(rData.ws, {
              type: 'bitrate-update',
              bitrate: msg.bitrate,
            });
          }
        }
        break;

      default:
        console.warn('Unknown message type from client:', msg.type);
    }
  });

  ws.on('close', () => {
    if (ws._remoteId) {
      const remoteId = ws._remoteId;
      remotes.delete(remoteId);
      broadcastToStudios({
        type: 'remote-disconnected',
        id: remoteId,
      });
    } else {
      studios.delete(ws);
    }
  });
});

// Start HTTP + WebSocket server
const PORT = process.env.PORT || 3030;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
