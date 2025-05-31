/**
 * server.js
 *
 * Node.js signaling server for WebRTC remote audio contributions,
 * with added “kick-remote” support so the studio can forcibly disconnect a remote.
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

const PORT = process.env.PORT || 3030;
const ALLOWED_ORIGIN = 'https://webrtc.brfm.net'; // only accept WS from this origin
const LOG_DIR = path.join(__dirname, 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

// Winston logger with daily rotation
const transport = new winston.transports.DailyRotateFile({
  filename: path.join(LOG_DIR, 'signal-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(
      (info) => `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`
    )
  ),
  transports: [transport],
});

/////////////////////////////////////////////////////
// 2. EXPRESS SETUP (SERVE STATIC)
/////////////////////////////////////////////////////

const app = express();
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server (noServer: true so we can do our own origin check)
const wss = new WebSocketServer({ noServer: true });

// Mapping: remoteID -> { socket, name, state }
// state ∈ { waiting, connecting, offered, connected }
const remotes = new Map();
// Single studio socket (if connected)
let studioSocket = null;

/**
 * Send a JSON‐serializable object to one WebSocket.
 */
function sendToSocket(ws, messageObj) {
  try {
    ws.send(JSON.stringify(messageObj));
  } catch (err) {
    logger.error(`Failed to send to socket: ${err.message}`);
  }
}

/**
 * Send to the studio (if connected).
 */
function sendToStudio(messageObj) {
  if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
    sendToSocket(studioSocket, messageObj);
  }
}

/**
 * Send to a specific remote (if exists).
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
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    logger.warn(`WebSocket connection from disallowed origin: ${origin}`);
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Ping/Pong heartbeat to detect stale clients
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.id = null;
  ws.role = null;
  ws.name = null;

  logger.info(`New WebSocket connection (ip=${req.socket.remoteAddress})`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logger.warn(`Invalid JSON from client: ${err.message}`);
      return;
    }

    if (!msg.type) {
      logger.warn('Received message without "type" field');
      return;
    }

    switch (msg.type) {
      case 'join':
        /**
         * { type: 'join', role: 'studio' | 'remote', name: '<displayName>' }
         */
        try {
          const { role, name } = msg;
          if (role !== 'studio' && role !== 'remote') {
            throw new Error('Invalid role');
          }
          ws.role = role;
          ws.name = String(name).slice(0, 50); // limit length

          if (role === 'studio') {
            if (studioSocket) {
              sendToSocket(ws, { type: 'error', message: 'Studio already connected' });
              ws.close();
              logger.warn('Rejected second studio connection');
              return;
            }
            ws.id = 'studio';
            studioSocket = ws;
            logger.info(`Studio joined (name=${ws.name})`);

            // Send existing remotes to the newly-connected studio
            const existing = [];
            for (const [id, { name: rname, state }] of remotes.entries()) {
              existing.push({ id, name: rname, state });
            }
            sendToSocket(ws, { type: 'existing-remotes', remotes: existing });
          } else {
            // A remote joins
            const remoteID = uuidv4();
            ws.id = remoteID;
            remotes.set(remoteID, { socket: ws, name: ws.name, state: 'waiting' });
            logger.info(`Remote joined (id=${remoteID}, name=${ws.name}, state=waiting)`);

            sendToSocket(ws, { type: 'id-assigned', id: remoteID });

            // Notify studio of new-waiting remote
            if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
              sendToStudio({
                type: 'new-remote',
                id: remoteID,
                name: ws.name,
                state: 'waiting',
              });
            }
          }
        } catch (err) {
          logger.error(`Error in join: ${err.message}`);
          sendToSocket(ws, { type: 'error', message: 'Join failed' });
        }
        break;

      case 'check-studio':
        /**
         * { type: 'check-studio' }
         * Respond with: { type: 'studio-status', connected: true|false }
         */
        try {
          const isConnected = !!(studioSocket && studioSocket.readyState === studioSocket.OPEN);
          sendToSocket(ws, { type: 'studio-status', connected: isConnected });
        } catch (err) {
          logger.error(`Error handling check-studio: ${err.message}`);
        }
        break;

      case 'connect-remote':
        /**
         * { type: 'connect-remote', from: 'studio', target: '<remoteID>' }
         */
        try {
          const { from, target } = msg;
          if (from !== 'studio') throw new Error('Only studio can connect remotes');
          if (!target) throw new Error('Missing target remoteID');

          const entry = remotes.get(target);
          if (!entry) throw new Error(`Remote ${target} not found`);

          entry.state = 'connecting';
          logger.info(`Studio requested connection for remote ${target}`);

          // Instruct remote to start-call
          sendToRemote(target, { type: 'start-call' });

          // Notify studio UI of state change
          sendToStudio({ type: 'remote-state-change', id: target, state: 'connecting' });
        } catch (err) {
          logger.error(`Error in connect-remote: ${err.message}`);
        }
        break;

      case 'offer':
        /**
         * { type: 'offer', from: '<remoteID>', sdp: '<SDP offer>' }
         */
        try {
          const { from, sdp } = msg;
          if (!from || !sdp) throw new Error('Missing fields in offer');
          if (ws.role !== 'remote') throw new Error('Only remotes send offers');

          const entry = remotes.get(from);
          if (!entry || entry.state !== 'connecting') {
            logger.warn(`Unexpected offer from remote ${from} in state ${entry?.state}`);
            return;
          }
          entry.state = 'offered';

          // Forward to studio
          if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
            sendToStudio({ type: 'offer', from, sdp });
            logger.info(`Forwarded offer from remote ${from} to studio`);
          }
        } catch (err) {
          logger.error(`Error handling offer: ${err.message}`);
        }
        break;

      case 'answer':
        /**
         * { type: 'answer', from: 'studio', target: '<remoteID>', sdp: '<SDP answer>' }
         */
        try {
          const { from, target, sdp } = msg;
          if (from !== 'studio') throw new Error('Only studio can send answers');
          if (!target || !sdp) throw new Error('Missing fields in answer');

          const entry = remotes.get(target);
          if (!entry) throw new Error(`Remote ${target} not found`);
          entry.state = 'connected';

          // Forward to the remote
          sendToRemote(target, { type: 'answer', from: 'studio', sdp });
          logger.info(`Forwarded answer from studio to remote ${target}`);

          // Notify studio UI of state change
          sendToStudio({ type: 'remote-state-change', id: target, state: 'connected' });
        } catch (err) {
          logger.error(`Error handling answer: ${err.message}`);
        }
        break;

      case 'candidate':
        /**
         * { type: 'candidate', from: '<senderID>', target: '<targetID>', candidate: { ... } }
         */
        try {
          const { from, target, candidate } = msg;
          if (!from || !target || !candidate) throw new Error('Missing fields in candidate');

          if (target === 'studio') {
            if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
              sendToStudio({ type: 'candidate', from, candidate });
              logger.verbose(`Forwarded ICE candidate from ${from} to studio`);
            }
          } else {
            sendToRemote(target, { type: 'candidate', from, candidate });
            logger.verbose(`Forwarded ICE candidate from ${from} to remote ${target}`);
          }
        } catch (err) {
          logger.error(`Error handling candidate: ${err.message}`);
        }
        break;

      case 'kick-remote':
        /**
         * { type: 'kick-remote', from: 'studio', target: '<remoteID>' }
         */
        try {
          const { from, target } = msg;
          if (from !== 'studio') throw new Error('Only studio can kick remotes');
          if (!target) throw new Error('Missing target remoteID');

          const entry = remotes.get(target);
          if (!entry) throw new Error(`Remote ${target} not found`);

          // Inform remote it was kicked
          sendToRemote(target, {
            type: 'kicked',
            reason: 'You have been disconnected by the studio.',
          });

          // Close the remote's socket after a brief delay
          setTimeout(() => {
            if (entry.socket.readyState === entry.socket.OPEN) {
              entry.socket.close();
            }
          }, 100);

          // Remove from remotes map
          remotes.delete(target);
          logger.info(`Kicked remote ${target}`);

          // Notify studio UI so it can remove that contributor from UI
          sendToStudio({ type: 'remote-disconnected', id: target });
        } catch (err) {
          logger.error(`Error handling kick-remote: ${err.message}`);
        }
        break;

      case 'chat':
        /**
         * { type: 'chat', from: '<senderID>', name: '<displayName>', message: '<text>', target: '<targetID>|studio|all' }
         */
        try {
          const { from, name, message, target } = msg;
          if (!from || !name || !message || !target) throw new Error('Missing fields in chat');

          const sanitized = String(message)
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .slice(0, 500);

          const chatMsg = { type: 'chat', from, name, message: sanitized };

          if (target === 'studio') {
            sendToStudio(chatMsg);
            logger.info(`Chat from ${from}→studio: ${sanitized}`);
          } else if (target === 'all') {
            sendToStudio(chatMsg);
            for (const [id, { socket }] of remotes.entries()) {
              if (socket.readyState === socket.OPEN) {
                sendToSocket(socket, chatMsg);
              }
            }
            logger.info(`Broadcast chat from ${from}: ${sanitized}`);
          } else {
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
      studioSocket = null;
      // Notify all remotes that studio disconnected
      for (const [id, { socket }] of remotes.entries()) {
        if (socket.readyState === socket.OPEN) {
          sendToSocket(socket, { type: 'studio-disconnected' });
        }
      }
      logger.info('Studio disconnected; notified all remotes.');
    } else if (ws.role === 'remote' && ws.id) {
      const rid = ws.id;
      const rname = remotes.get(rid)?.name;
      remotes.delete(rid);
      logger.info(`Remote removed (id=${rid}, name=${rname})`);
      // Notify studio that remote disconnected
      if (studioSocket && studioSocket.readyState === studioSocket.OPEN) {
        sendToStudio({ type: 'remote-disconnected', id: rid });
      }
    }
  });
});

// Ping/pong to detect stale connections every 30s
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      logger.warn(`Terminating stale socket (id=${ws.id}, role=${ws.role})`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

// Start the HTTP + WebSocket server
server.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  console.log(`Signaling server listening on port ${PORT}`);
});
