# WebRTC Remote Audio Contribution System

This repository provides a complete WebRTC-based remote audio contribution system for a professional radio station. Remote contributors can send high-quality stereo Opus audio (48 kHz) to a central studio interface, enabling low-latency, live broadcasting.

## Table of Contents

1. [Features](#features)
2. [Prerequisites](#prerequisites)
3. [Directory Structure](#directory-structure)
4. [Installation](#installation)
5. [Running Locally](#running-locally)
6. [Docker Deployment](#docker-deployment)
7. [Nginx Reverse Proxy Configuration](#nginx-reverse-proxy-configuration)
8. [Security Considerations](#security-considerations)
9. [File Overview](#file-overview)
10. [Usage](#usage)

---

## Features

- **Signaling Server**: Node.js WebSocket server (using `ws`) to exchange SDP and ICE candidates.
- **High-Quality Audio**: WebRTC configured for Opus (48 kHz stereo).
- **TURN/STUN Support**: Pre-configured to use `turn:turn.nkpa.co.uk:3478`.
- **Studio UI**:
  - Lists connected contributors.
  - Shows real-time stereo audio meters (left/right channels).
  - Mute/unmute buttons per contributor.
  - Displays connection status and negotiated Opus codec details.
  - Built-in chat window to message any contributor.
- **Remote UI**:
  - Captures microphone audio.
  - Auto-reconnect on connection loss.
  - Mute/unmute self.
  - “Send Tone” button: transmits a 1 kHz test tone.
  - Real-time stereo audio meter.
  - Chat window to send messages to the studio.
- **Logging**: Uses `winston` with daily-rotated log files for all signaling events.
- **Dockerized**: `Dockerfile` and `docker-compose.yml` for easy deployment.

---

## Prerequisites

- **Node.js** ≥ 14 (the Docker container uses Node 18).
- **npm** (comes with Node.js).
- Optional but recommended: **Docker** and **docker-compose** for containerized deployment.
- A valid TURN/STUN server (the code uses `turn.nkpa.co.uk:3478` with preset credentials).

---

## Directory Structure

```
.
├── Dockerfile
├── docker-compose.yml
├── README.md
├── package.json
├── server.js
└── public
    ├── studio.html
    ├── studio.js
    ├── remote.html
    ├── remote.js
    └── style.css
```

- `server.js`: Main Node.js application (Express + WebSocket signaling).
- `package.json`: Dependency listing.
- `public/`: Front-end files served statically.
  - `studio.html` & `studio.js`: Studio control interface.
  - `remote.html` & `remote.js`: Remote contributor interface.
  - `style.css`: Shared styling.
- `Dockerfile` & `docker-compose.yml`: Containerization & deployment.

---

## Installation

1. **Clone this repository**:

   ```bash
   git clone https://github.com/nsilvo/studiocontrol.git
   cd studiocontrol
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

---

## Running Locally

1. **Start the signaling server**:

   ```bash
   npm start
   ```

   By default, it listens on port `3000`.

2. **Access the Studio Interface**:

   Open a browser and navigate to:

   ```
   http://localhost:3000/studio.html
   ```

3. **Access the Remote Interface**:

   Open another browser (can be a separate machine) and go to:

   ```
   http://localhost:3000/remote.html
   ```

   Enter your display name and click “Connect.” You’ll be prompted to grant microphone access.

### Notes

- The server enforces that WebSocket connections must originate from `https://webrtc.brfm.net`. If developing locally, either:
  - Temporarily comment out the origin check in `server.js`, or
  - Run a local HTTPS server on `webrtc.brfm.net` via `/etc/hosts` → `127.0.0.1 webrtc.brfm.net` plus a self-signed certificate.

---

## Docker Deployment

1. **Build the Docker image**:

   ```bash
   docker-compose build
   ```

2. **Run via Docker Compose**:

   ```bash
   docker-compose up -d
   ```

   - This maps container port `3000` to host port `3000`.
   - Logs are stored inside the container at `/usr/src/app/logs` (rotated daily).

3. **Verify**:

   ```bash
   docker ps
   ```

   You should see `webrtc-radio-app` running.

4. **Access**:

   - Studio: `http://<your-server-ip>:3000/studio.html`
   - Remote: `http://<your-server-ip>:3000/remote.html`

---

## Nginx Reverse Proxy Configuration

Below is a sample Nginx configuration to reverse-proxy and terminate HTTPS for `webrtc.brfm.net`:

```nginx
server {
    listen 80;
    server_name webrtc.brfm.net;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name webrtc.brfm.net;

    ssl_certificate     /etc/ssl/certs/your_cert.pem;
    ssl_certificate_key /etc/ssl/private/your_key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

- **Important**: The Node.js app is listening on port `3000` without TLS. Nginx handles HTTPS and WebSocket upgrades (`proxy_set_header Upgrade`).

---

## Security Considerations

1. **Origin Check**: `server.js` only accepts WebSocket requests from `https://webrtc.brfm.net`.
2. **Input Validation**: All incoming messages are JSON-parsed inside `try/catch`. Chat messages are sanitized (stripping `<`/`>`).
3. **Credential Management**: TURN credentials (`username`, `credential`) are hardcoded as per requirements but can easily be moved to environment variables for improved security.
4. **Logging**: All signaling events are logged with timestamps. Logs rotate daily and keep 14 days of archives.
5. **Production Best Practices**:
   - Run behind a firewall.
   - Use real TLS certificates via Let’s Encrypt (Nginx).
   - Consider restricting `getUserMedia` to audio only (no video); this code already does that.

---

## File Overview

### `server.js`

- Sets up Express to serve `public/` statically.
- Creates a WebSocket server via `ws` on the same HTTP server.
- Performs origin validation (`https://webrtc.brfm.net`).
- Manages one studio and multiple remotes.
- Routes signaling messages (`offer`, `answer`, `candidate`, `chat`) accordingly.
- Logs all events using `winston` + `winston-daily-rotate-file`.

### `public/style.css`

- Shared CSS for both studio and remote UIs (layout, buttons, meters, chat).

### `public/studio.html` / `public/studio.js`

- **UI**: Lists contributors, mute/unmute, real-time stereo meters, status, codec info, and chat.
- **JS** (`studio.js`):
  - Maintains a `Map` of remote‐ID → Peer data (PC, DOM nodes, meters).
  - On `offer` from remote: create `RTCPeerConnection`, parse Opus details from SDP, send `answer`.
  - Attach incoming media to a hidden `<audio>` per remote.
  - Sets up `AudioContext` to compute RMS for left/right channels (drawn as two colored bars).
  - Forwards ICE candidates.
  - Chat broadcast and individual messaging.

### `public/remote.html` / `public/remote.js`

- **UI**: Gather name, connect, show “Mute”, “Send Tone”, stereo meter, chat.
- **JS** (`remote.js`):
  - On connect: sends `{ type:'join', role:'remote', name }`.
  - Receives assigned ID → uses `getUserMedia({ audio: { sampleRate: 48000, channelCount: 2 } })`.
  - Creates `RTCPeerConnection`, adds microphone track, creates SDP offer to studio.
  - Replaces track with 1 kHz test tone (via `AudioContext`+`OscillatorNode`) when requested.
  - Local stereo meter via `AudioContext` + `AnalyserNode`s → drawn as two bars.
  - Chat with studio.
  - Auto-reconnect on WebSocket loss.

### `Dockerfile` / `docker-compose.yml`

- Containerizes the Node.js app for easy deployment.
- Exposes port `3000`.
- Rebuild when code changes.

---

## Usage

1. Start the server (locally or in Docker).
2. Visit `https://webrtc.brfm.net/studio.html` as the producer/host.
3. Remotes open `https://webrtc.brfm.net/remote.html` in modern browsers (Chrome, Firefox, Edge).
4. Each remote grants mic access, enters their display name, and connects.
5. The studio UI will display each remote in the list, show real-time meters, allow mute/unmute, and chat.

**Note**: For best results, use wired or high-quality USB microphones on the remote side. The system uses Opus at 48 kHz stereo, so ensure adequate bandwidth (≥100 kbps upstream) and low packet‐loss.

---

Thank you for using this WebRTC system. Happy broadcasting!
