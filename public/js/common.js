/**
 * public/js/common.js
 * Shared utility functions for Studio, Remote, and Sports pages.
 */

// WebSocket wrapper to handle auto-reconnect
function createReconnectingWebSocket(url, protocols = []) {
  let ws;
  let listeners = [];
  let shouldReconnect = true;

  function connect() {
    ws = new WebSocket(url, protocols);

    ws.addEventListener('open', () => {
      console.log('WebSocket connected');
    });

    ws.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      listeners.forEach(cb => cb(data));
    });

    ws.addEventListener('close', () => {
      console.log('WebSocket disconnected, attempting to reconnect in 2s...');
      if (shouldReconnect) {
        setTimeout(connect, 2000);
      }
    });

    ws.addEventListener('error', err => {
      console.error('WebSocket error', err);
      ws.close();
    });
  }

  connect();

  return {
    send: msgObj => {
      const json = JSON.stringify(msgObj);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      } else {
        console.warn('WebSocket not open yet, cannot send:', msgObj);
      }
    },
    onMessage: callback => {
      listeners.push(callback);
    },
    close: () => {
      shouldReconnect = false;
      ws.close();
    }
  };
}

// Helper: create a canvas-based PPM meter (mono)
function createPPMMeter(audioContext, sourceNode, canvasElement) {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  sourceNode.connect(analyser);

  const canvasCtx = canvasElement.getContext('2d');
  const WIDTH = canvasElement.width;
  const HEIGHT = canvasElement.height;

  function draw() {
    requestAnimationFrame(draw);
    const dataArray = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(dataArray);

    canvasCtx.fillStyle = 'rgb(0, 0, 0)';
    canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = 'lime';
    canvasCtx.beginPath();

    const sliceWidth = WIDTH * 1.0 / analyser.fftSize;
    let x = 0;

    for (let i = 0; i < analyser.fftSize; i++) {
      const v = dataArray[i] / 128.0;
      const y = v * HEIGHT / 2;

      if (i === 0) {
        canvasCtx.moveTo(x, y);
      } else {
        canvasCtx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    canvasCtx.lineTo(WIDTH, HEIGHT / 2);
    canvasCtx.stroke();
  }

  draw();

  return analyser;
}

// Helper: getRTCPeerConnection config (with STUN servers)
function getRTCConfig() {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // Add TURN servers here if required in production
    ]
  };
}

/**
 * Utility to draw a live graph of stats (jitter & bitrate).
 * containerElement: a <canvas> element
 * callback: function(graphCtx, x, y, width, height) to draw each frame
 */
function startStatGraph(canvasElement, drawFrame) {
  const ctx = canvasElement.getContext('2d');
  const WIDTH = canvasElement.width;
  const HEIGHT = canvasElement.height;
  let x = 0;

  function loop() {
    requestAnimationFrame(loop);
    // Shift canvas left by 1 pixel
    const imageData = ctx.getImageData(1, 0, WIDTH - 1, HEIGHT);
    ctx.putImageData(imageData, 0, 0);
    // Clear rightmost column
    ctx.clearRect(WIDTH - 1, 0, 1, HEIGHT);

    // Draw new data point
    drawFrame(ctx, WIDTH - 1, HEIGHT);
  }

  loop();
}