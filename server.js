/**
 * server.js (CommonJS version)
 *
 * Node.js WebSocket signaling server for:
 *  - WebRTC peer connections (audio)
 *  - Exchanging SDP offers/answers and ICE candidates
 *  - Room-based or ID-based pairing (“studio” ↔ multiple remotes/sports)
 *  - Chat messages
 *  - Mute/unmute, kick, bitrate updates
 *  - Sports-specific messages: score-update, goal, reporter-recording
 *
 * Uses:
 *  - ws library
 *  - winston for rotating log files
 *  - origin check: only accept wss://webrtc.brfm.net
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const WebSocket = require('ws');
const winston = require('winston');
require('winston-daily-rotate-file');

// --- Logger Setup ---
const logDir = 'logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const transport = new winston.transports.DailyRotateFile({
  filename: path.join(logDir, '%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: false,
  maxFiles: '14d',
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`
    )
  ),
  transports: [transport],
});

// --- HTTP Server (serves static files) ---
const httpServer = http.createServer((req, res) => {
  // Only serve files from ./public by default
  let parsedUrl = url.parse(req.url);
  let pathname = `./public${parsedUrl.pathname}`;
  if (parsedUrl.pathname === '/') {
    pathname = './public/index.html';
  }

  const ext = path.parse(pathname).ext;
  const map = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webm': 'video/webm',
    '.json': 'application/json',
  };

  fs.exists(pathname, (exist) => {
    if (!exist) {
      res.statusCode = 404;
      res.end(`File ${pathname} not found!`);
      return;
    }

    // If directory, serve index.html inside
    if (fs.statSync(pathname).isDirectory()) {
      pathname += '/index.html';
    }

    fs.readFile(pathname, (err, data) => {
      if (err) {
        res.statusCode = 500;
        res.end(`Error getting file: ${err}.`);
      } else {
        res.setHeader('Content-type', map[ext] || 'text/plain');
        res.end(data);
      }
    });
  });
});

// --- WebSocket Server ---
const wss = new WebSocket.Server({ server: httpServer });

const STUDIO_CLIENTS = new Set(); // sockets where role === 'studio'
const REMOTE_CLIENTS = new Map();  // id → { ws, name, state, teams }

function sendTo(ws, msg) {
  ws.send(JSON.stringify(msg));
}
function broadcastToStudios(msg) {
  STUDIO_CLIENTS.forEach((studioWs) => {
    sendTo(studioWs, msg);
  });
}

// Generate a UUID-like ID for remotes
function generateID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// On new WebSocket connection
wss.on('connection', (ws, req) => {
  // Origin check
  const origin = req.headers.origin;
  if (origin !== 'https://webrtc.brfm.net') {
    logger.warn(`Rejected connection from origin: ${origin}`);
    ws.close();
    return;
  }

  let clientRole = null; // 'studio' or 'remote' or 'sports'
  let clientID = null;

  ws.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (err) {
      logger.error(`Invalid JSON: ${err}`);
      return;
    }

    const type = msg.type;

    switch (type) {
      // --------------------------
      case 'join':
        // { type:'join', role:'studio'|'remote'|'sports', name, [teamA, teamB] }
        clientRole = msg.role;
        if (clientRole === 'studio') {
          STUDIO_CLIENTS.add(ws);
          logger.info('Studio joined');
          // Send existing remotes to this studio
          const remotes = [];
          REMOTE_CLIENTS.forEach((entry, id) => {
            remotes.push({ id, name: entry.name, state: entry.state });
          });
          sendTo(ws, { type: 'existing-remotes', remotes });
        } else if (clientRole === 'remote' || clientRole === 'sports') {
          clientID = generateID();
          const name = msg.name || 'Unknown';
          const state = 'waiting';
          const teams =
            clientRole === 'sports'
              ? { teamA: msg.teamA, teamB: msg.teamB }
              : null;
          REMOTE_CLIENTS.set(clientID, { ws, name, state, teams });
          // Notify this remote of its ID
          sendTo(ws, { type: 'id-assigned', id: clientID });
          // Notify all studios of new remote
          broadcastToStudios({ type: 'new-remote', id: clientID, name, state });
          logger.info(`Remote joined: ${clientID} (${name})`);
        }
        break;

      // --------------------------
      case 'connect-remote':
        // { type:'connect-remote', from:'studio', target:remoteID }
        if (clientRole === 'studio') {
          const targetID = msg.target;
          const entry = REMOTE_CLIENTS.get(targetID);
          if (entry) {
            entry.state = 'connecting';
            broadcastToStudios({
              type: 'remote-state-change',
              id: targetID,
              state: 'connecting',
            });
            // Ask remote to start call
            sendTo(entry.ws, { type: 'start-call' });
            logger.info(`Studio requested connection to remote ${targetID}`);
          }
        }
        break;

      // --------------------------
      case 'offer':
        // { type:'offer', from:remoteID, sdp }
        if (clientRole === 'remote' || clientRole === 'sports') {
          const fromID = msg.from;
          const sdp = msg.sdp;
          const entry = REMOTE_CLIENTS.get(fromID);
          if (entry) {
            entry.state = 'offered';
            broadcastToStudios({
              type: 'remote-state-change',
              id: fromID,
              state: 'offered',
            });
          }
          broadcastToStudios({ type: 'offer', from: fromID, sdp });
          logger.info(`Forwarded offer from ${fromID} to studio`);
        }
        break;

      // --------------------------
      case 'answer':
        // { type:'answer', from:'studio', target:remoteID, sdp }
        if (clientRole === 'studio') {
          const targetID = msg.target;
          const entry = REMOTE_CLIENTS.get(targetID);
          if (entry) {
            sendTo(entry.ws, {
              type: 'answer',
              from: 'studio',
              sdp: msg.sdp,
            });
            entry.state = 'connected';
            broadcastToStudios({
              type: 'remote-state-change',
              id: targetID,
              state: 'connected',
            });
            logger.info(`Forwarded answer to remote ${targetID}`);
          }
        }
        break;

      // --------------------------
      case 'candidate':
        // { type:'candidate', from:<senderID>, target:<recipientID|'studio'>, candidate }
        if (msg.target === 'studio') {
          broadcastToStudios({
            type: 'candidate',
            from: msg.from,
            candidate: msg.candidate,
          });
        } else {
          const entry = REMOTE_CLIENTS.get(msg.target);
          if (entry) {
            sendTo(entry.ws, {
              type: 'candidate',
              from: 'studio',
              candidate: msg.candidate,
            });
          }
        }
        break;

      // --------------------------
      case 'mute-update':
        // { type:'mute-update', from:<studio|remote>, target:<studio|remote>, muted:true|false }
        if (clientRole === 'studio') {
          const targetID = msg.target;
          const entry = REMOTE_CLIENTS.get(targetID);
          if (entry) {
            sendTo(entry.ws, {
              type: 'mute-update',
              from: 'studio',
              muted: msg.muted,
            });
          }
        } else if (clientRole === 'remote' || clientRole === 'sports') {
          broadcastToStudios({
            type: 'mute-update',
            from: msg.from,
            muted: msg.muted,
          });
        }
        break;

      // --------------------------
      case 'bitrate-update':
        // { type:'bitrate-update', from:'studio', target:remoteID, bitrate }
        if (clientRole === 'studio') {
          const entry = REMOTE_CLIENTS.get(msg.target);
          if (entry) {
            sendTo(entry.ws, {
              type: 'bitrate-update',
              bitrate: msg.bitrate,
            });
          }
        }
        break;

      // --------------------------
      case 'kick-remote':
        // { type:'kick-remote', from:'studio', target:remoteID }
        if (clientRole === 'studio') {
          const targetID = msg.target;
          const entry = REMOTE_CLIENTS.get(targetID);
          if (entry) {
            sendTo(entry.ws, {
              type: 'kicked',
              reason: 'Kicked by studio.',
            });
            entry.ws.close();
            logger.info(`Kicked remote ${targetID}`);
          }
        }
        break;

      // --------------------------
      case 'chat':
        // { type:'chat', from:<id>, name:<string>, message:<string>, [target:'studio'] }
        broadcastToStudios({
          type: 'chat',
          from: msg.from,
          name: msg.name,
          message: msg.message,
        });
        break;

      // --------------------------
      // SPORTS-SPECIFIC MESSAGES
      // --------------------------
      case 'score-update':
        // { type:'score-update', from:<remoteID>, teamA, teamB, scoreA, scoreB }
        broadcastToStudios({
          type: 'score-update',
          teamA: msg.teamA,
          teamB: msg.teamB,
          scoreA: msg.scoreA,
          scoreB: msg.scoreB,
        });
        logger.info(
          `Score update from ${msg.from}: ${msg.teamA} ${msg.scoreA}-${msg.scoreB} ${msg.teamB}`
        );
        break;

      case 'goal':
        // { type:'goal', from:<remoteID> }
        broadcastToStudios({ type: 'goal', from: msg.from });
        logger.info(`Goal event from ${msg.from}`);
        break;

      case 'reporter-recording':
        // { type:'reporter-recording', from:<remoteID>, name:<reporterName>, data:<base64> }
        broadcastToStudios({
          type: 'reporter-recording',
          from: msg.from,
          name: msg.name,
          data: msg.data,
        });
        logger.info(`Received reporter segment from ${msg.from}`);
        break;

      // --------------------------
      default:
        logger.warn(`Unknown message type: ${type}`);
        break;
    }
  });

  ws.on('close', () => {
    // Cleanup: remove studio or remote
    if (clientRole === 'studio') {
      STUDIO_CLIENTS.delete(ws);
      logger.info('Studio disconnected');
    } else if (clientRole === 'remote' || clientRole === 'sports') {
      if (clientID && REMOTE_CLIENTS.has(clientID)) {
        REMOTE_CLIENTS.delete(clientID);
        broadcastToStudios({
          type: 'remote-disconnected',
          id: clientID,
        });
        logger.info(`Remote disconnected: ${clientID}`);
      }
    }
  });
});

// Start HTTP + WebSocket server on port 3030
const PORT = process.env.PORT || 3030;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  logger.info(`Server started on port ${PORT}`);
});
