/**
 * server.js
 *
 * - WebSocket signaling server (using ws) on top of an Express app.
 * - Serves static files (studio.html, remote.html, recordings.html, etc.).
 * - Accepts uploads (multipart/form-data) at POST /upload and saves them under ./recordings/.
 * - Exposes GET /recordings to return a JSON list of stored recordings.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import cors from 'cors';
import { fileURLToPath } from 'url';

// __dirname workaround for ES modules:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create recordings directory if it doesn’t exist
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
    // Preserve original filename or use timestamp + original name
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/\s+/g, '_');
    cb(null, `${timestamp}_${safeName}`);
  },
});
const upload = multer({ storage });

// Express app
const app = express();
app.use(cors());

// Serve static frontend files from "public" directory (adjust if your HTML lives elsewhere)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// POST /upload – accept multipart files (field name "files")
app.post('/upload', upload.array('files'), (req, res) => {
  // Each file is now stored under ./recordings
  // You can also parse additional metadata from req.body if needed.
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }

  // Respond with list of saved filenames
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
    // Only return .webm or .wav etc. (filter if you like)
    // For now, return all filenames
    return res.json({ recordings: files });
  });
});

// Serve individual recording files statically under /recordings/* 
app.use('/recordings', express.static(recordingsDir));

// Create HTTP server and bind Express
const server = http.createServer(app);

// WebSocket server (ws) attaches to the same HTTP server
const wss = new WebSocketServer({ server });

// A simple in‐memory store of connected clients
const studios = new Set();
const remotes = new Map(); // remoteId → { ws, name }

// Helper to broadcast to all studios
function broadcastToStudios(obj) {
  const msg = JSON.stringify(obj);
  studios.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  });
}

// Helper to send message to specific client
function sendToClient(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws, req) => {
  // Only allow connections from our origin (e.g. https://webrtc.brfm.net)
  const origin = req.headers.origin;
  if (origin !== 'https://webrtc.brfm.net') {
    ws.close();
    console.warn('Connection from disallowed origin:', origin);
    return;
  }

  // We'll wait for the client to send a "join" message identifying role
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
          // Send existing remotes (if any)
          remotes.forEach(({ name }, remoteId) => {
            sendToClient(ws, {
              type: 'new-remote',
              id: remoteId,
              name,
            });
          });
        } else if (msg.role === 'remote') {
          const remoteId = msg.id || crypto.randomUUID();
          remotes.set(remoteId, { ws, name: msg.name });
          console.log(`Remote joined: ${msg.name} (${remoteId})`);
          // Notify all studios of new remote
          broadcastToStudios({
            type: 'new-remote',
            id: remoteId,
            name: msg.name,
          });
          // Also remember this ws’s remoteId so we can clean up on close
          ws._remoteId = remoteId;
        }
        break;

      case 'ready-for-offer':
        // { type:'ready-for-offer', target:<remoteId> }
        // Forward to the remote so it knows to createOffer()
        {
          const rData = remotes.get(msg.target);
          if (rData) {
            sendToClient(rData.ws, {
              type: 'start-call',
            });
          }
        }
        break;

      case 'offer':
        // { type:'offer', from:'<remoteId>', sdp }
        // Forward to all studios
        broadcastToStudios({
          type: 'offer',
          from: msg.from,
          sdp: msg.sdp,
        });
        break;

      case 'answer':
        // { type:'answer', from:'studio', target:'<remoteId>', sdp }
        // Forward to that remote only
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
          // from remote → studios
          broadcastToStudios({
            type: 'candidate',
            from: msg.from,
            candidate: msg.candidate,
          });
        } else if (msg.target === 'remote') {
          // from studio → remote
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
            sendToClient(rData.ws, {
              type: 'kick',
            });
            // Then close their socket
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

      case 'remote-disconnected':
        // (Not typically client‐initiated; server will detect on 'close'.)
        break;

      default:
        console.warn('Unknown message type from client:', msg.type);
    }
  });

  ws.on('close', () => {
    // If a remote closed unexpectedly
    if (ws._remoteId) {
      const remoteId = ws._remoteId;
      remotes.delete(remoteId);
      // Notify studios
      broadcastToStudios({
        type: 'remote-disconnected',
        id: remoteId,
      });
    } else {
      // Must be a studio
      studios.delete(ws);
    }
  });

  /////////////////////////////////////////////////////
  // Start HTTP + WebSocket server
  /////////////////////////////////////////////////////
  const PORT = process.env.PORT || 3030;
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
})();
