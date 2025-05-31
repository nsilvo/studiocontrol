/**
 * server.js
 *
 * Node.js signaling server for WebRTC remote audio contributions.
 * - Uses Express to serve static frontend files from /public.
 * - Uses ws to handle WebSocket signaling (SDP, ICE, chat, etc.).
 * - Enforces origin checking (only https://webrtc.brfm.net).
 * - Logs signaling events to daily‐rotated files via winston.
 * - Manages one “studio” socket and multiple “remote” sockets in a room.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const winston = require('winston');
require('winston-daily-rotate-file');
const { v4: uuidv4 } = require('uuid');

/////////////////////////////////////////////////////
// 1. CONFIGURATION
/////////////////////////////////////////////////////

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = 'https://webrtc.brfm.net'; // only accept WS connections from this origin
const LOG_DIR = path.join(__dirname, 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

// Winston logger with daily rotate
const transport = new winston.transports.DailyRotateFile({
  filename: path.join(LOG_DIR, 'signal-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d'
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(
      info => `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`
    )
  ),
  transports: [transport]
});

/////////////////////////////////////////////////////
// 2. EXPRESS SETUP (SERVE STATIC)
/////////////////////////////////////////////////////

const app = express();
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server, attach to HTTP server
const wss = new WebSocketServer({ noServer: true });

// Mapping: remoteID -> { socket, name }
const remotes = new Map();
// Single studio socket (if connected)
let studioSocket = null;

/**
 * Broadcasts a JSON‐serializable object to a specific socket.
 */
function sendToSocket(ws, messageObj) {
  try {
    ws.send(JSON.stringify(messageObj));
  } catch (err) {
    logger.error(`Failed to send to socket: ${err.message}`);
  }
}

/**
 * Broadcasts a JSON‐serializable object to the studio (if connected).
 */
function sendToStudio(messageObj) {
  if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
    sendToSocket(studioSocket, messageObj);
  }
}

/**
 * Broadcasts a JSON‐serializable object to a specific remote (if exists).
 */
function sendToRemote(remoteID, messageObj) {
  const entry = remotes.get(remoteID);
  if (entry && entry.socket.readyState === entry.socket.OPEN) {
    sendToSocket(entry.socket, messageObj);
  }
}

/////////////////////////////////////////////////////
// 3. WS CONNECTION & SIGNALING LOGIC
/////////////////////////////////////////////////////

// Handle HTTP → upgrade to WebSocket
server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin !== ALLOWED_ORIGIN) {
    // Reject if origin not allowed
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    logger.warn(`Connection from disallowed origin: ${origin}`);
    return;
  }

  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
});

// Heartbeat: ping/pong to detect stale connections
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  // Assign a temporary ID until “join” is processed
  ws.id = null;
  ws.role = null;
  ws.name = null;

  logger.info(`New WebSocket connection (ip=${req.socket.remoteAddress})`);

  ws.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logger.warn(`Invalid JSON from a client: ${err.message}`);
      return;
    }

    // Basic validation: must have type
    if (!msg.type) {
      logger.warn('Received message without type field');
      return;
    }

    switch (msg.type) {
      case 'join':
        /**
         * {
         *   type: 'join',
         *   role: 'studio' | 'remote',
         *   name: '<displayName>'
         * }
         */
        try {
          const { role, name } = msg;
          if (role !== 'studio' && role !== 'remote') {
            throw new Error('Invalid role');
          }
          ws.role = role;
          ws.name = String(name).slice(0, 50); // sanitize length

          if (role === 'studio') {
            // If a studio is already connected, reject this one
            if (studioSocket) {
              sendToSocket(ws, { type: 'error', message: 'Studio already connected' });
              ws.close();
              logger.warn('Rejected second studio connection');
              return;
            }
            ws.id = 'studio';
            studioSocket = ws;
            logger.info(`Studio joined (name=${ws.name})`);

            // Send existing remotes to the newly‐connected studio
            const existing = [];
            for (const [id, { name: rname }] of remotes.entries()) {
              existing.push({ id, name: rname });
            }
            sendToSocket(ws, { type: 'existing-remotes', remotes: existing });
          } else {
            // Remote joining
            const remoteID = uuidv4();
            ws.id = remoteID;
            remotes.set(remoteID, { socket: ws, name: ws.name });
            logger.info(`Remote joined (id=${remoteID}, name=${ws.name})`);

            // Inform the remote of its assigned ID
            sendToSocket(ws, { type: 'id-assigned', id: remoteID });

            // Notify studio about the new remote
            if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
              sendToStudio({
                type: 'new-remote',
                id: remoteID,
                name: ws.name
              });
            }
          }
        } catch (err) {
          logger.error(`Error handling join: ${err.message}`);
          sendToSocket(ws, { type: 'error', message: 'Join failed' });
        }
        break;

      case 'offer':
        /**
         * {
         *   type: 'offer',
         *   from: '<senderID>',
         *   sdp: '<SDP offer>'
         * }
         * Only remotes send offers to the studio.
         */
        try {
          const { from, sdp } = msg;
          if (!from || !sdp) throw new Error('Missing fields in offer');
          if (ws.role !== 'remote') throw new Error('Only remotes send offers');

          // Forward to studio
          if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
            sendToStudio({
              type: 'offer',
              from,
              sdp
            });
            logger.info(`Forwarded offer from remote ${from} to studio`);
          }
        } catch (err) {
          logger.error(`Error handling offer: ${err.message}`);
        }
        break;

      case 'answer':
        /**
         * {
         *   type: 'answer',
         *   from: 'studio',
         *   target: '<remoteID>',
         *   sdp: '<SDP answer>'
         * }
         * Only studio sends answers to remotes.
         */
        try {
          const { from, target, sdp } = msg;
          if (from !== 'studio') throw new Error('Only studio can send answers');
          if (!target || !sdp) throw new Error('Missing fields in answer');

          // Forward to the specified remote
          sendToRemote(target, {
            type: 'answer',
            from: 'studio',
            sdp
          });
          logger.info(`Forwarded answer from studio to remote ${target}`);
        } catch (err) {
          logger.error(`Error handling answer: ${err.message}`);
        }
        break;

      case 'candidate':
        /**
         * {
         *   type: 'candidate',
         *   from: '<senderID>',
         *   target: '<targetID>',
         *   candidate: { ...ICE candidate object... }
         * }
         */
        try {
          const { from, target, candidate } = msg;
          if (!from || !target || !candidate) throw new Error('Missing fields in candidate');

          // Determine where to forward: if target === 'studio', send to studio; else send to that remote
          if (target === 'studio') {
            if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
              sendToStudio({
                type: 'candidate',
                from,
                candidate
              });
              logger.verbose(`Forwarded ICE candidate from ${from} to studio`);
            }
          } else {
            // Forward to specific remote
            sendToRemote(target, {
              type: 'candidate',
              from,
              candidate
            });
            logger.verbose(`Forwarded ICE candidate from ${from} to remote ${target}`);
          }
        } catch (err) {
          logger.error(`Error handling candidate: ${err.message}`);
        }
        break;

      case 'chat':
        /**
         * {
         *   type: 'chat',
         *   from: '<senderID>',
         *   name: '<displayName>',
         *   message: '<text>',
         *   target: '<targetID>|studio|all'
         * }
         */
        try {
          const { from, name, message, target } = msg;
          if (!from || !name || !message || !target) throw new Error('Missing fields in chat');
          // Sanitize message: strip any HTML tags (basic defensive measure)
          const sanitized = String(message)
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .slice(0, 500); // limit length

          const chatMsg = {
            type: 'chat',
            from,
            name,
            message: sanitized
          };

          if (target === 'studio') {
            sendToStudio(chatMsg);
            logger.info(`Chat from ${from}→studio: ${sanitized}`);
          } else if (target === 'all') {
            // Broadcast to studio and all remotes
            sendToStudio(chatMsg);
            for (const [id, { socket }] of remotes.entries()) {
              if (socket.readyState === socket.OPEN) {
                sendToSocket(socket, chatMsg);
              }
            }
            logger.info(`Broadcast chat from ${from}: ${sanitized}`);
          } else {
            // Directed to a specific remote
            sendToRemote(target, chatMsg);
            logger.info(`Chat from ${from}→remote ${target}: ${sanitized}`);
          }
        } catch (err) {
          logger.error(`Error handling chat: ${err.message}`);
        }
        break;

      default:
        logger.warn(`Unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    logger.info(`WebSocket closed (id=${ws.id}, role=${ws.role})`);

    if (ws.role === 'studio') {
      // Studio disconnected
      studioSocket = null;
      // Optionally notify remotes (they might reload or keep trying)
      for (const [id, { socket }] of remotes.entries()) {
        if (socket.readyState === socket.OPEN) {
          sendToSocket(socket, {
            type: 'studio-disconnected'
          });
        }
      }
      logger.info('Studio disconnected; notified all remotes.');
    } else if (ws.role === 'remote' && ws.id) {
      // A remote disconnected: remove and notify studio
      const rid = ws.id;
      const rname = remotes.get(rid)?.name;
      remotes.delete(rid);
      logger.info(`Remote removed (id=${rid}, name=${rname})`);

      if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
        sendToStudio({
          type: 'remote-disconnected',
          id: rid
        });
      }
    }
  });
});

// Periodic ping to detect dead connections
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      logger.warn(`Terminating stale socket (id=${ws.id}, role=${ws.role})`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Start server
server.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  console.log(`Signaling server listening on port ${PORT}`);
});
