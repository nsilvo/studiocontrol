/**
 * public/js/recordings.js
 * 
 * Logic for the Recordings page:
 *  - Fetch list of recordings from /recordings
 *  - For each file: draw full waveform on <canvas>, set up playback with moving ticker
 */

const recordingsListDiv = document.getElementById('recordings-list');
const RECORDINGS_API = '/recordings';

async function fetchRecordings() {
  try {
    const res = await fetch(RECORDINGS_API);
    const json = await res.json();
    return json.recordings;
  } catch (err) {
    console.error('Error fetching recordings:', err);
    return [];
  }
}

async function displayRecordings() {
  const recordings = await fetchRecordings();
  recordings.forEach(filename => {
    createRecordingItem(filename);
  });
}

function createRecordingItem(filename) {
  const item = document.createElement('div');
  item.className = 'recording-item';

  const title = document.createElement('h2');
  title.textContent = filename;
  item.appendChild(title);

  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 80;
  item.appendChild(canvas);

  const playBtn = document.createElement('button');
  playBtn.textContent = 'Play';
  item.appendChild(playBtn);

  const audio = new Audio(`/recordings/${encodeURIComponent(filename)}`);
  audio.crossOrigin = 'anonymous';

  // Draw waveform once audio metadata is loaded
  audio.addEventListener('loadedmetadata', () => {
    drawWaveform(audio, canvas);
  });

  // Flashing ticker during playback
  let tickerInterval = null;
  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      audio.play();
      playBtn.textContent = 'Pause';
      startTicker(audio, canvas);
    } else {
      audio.pause();
      playBtn.textContent = 'Play';
      stopTicker();
    }
  });
  audio.addEventListener('ended', () => {
    playBtn.textContent = 'Play';
    stopTicker();
  });

  recordingsListDiv.appendChild(item);

  function startTicker(audioEl, canvasEl) {
    const ctx = canvasEl.getContext('2d');
    const WIDTH = canvasEl.width;
    const HEIGHT = canvasEl.height;
    tickerInterval = setInterval(() => {
      // Calculate position based on currentTime / duration
      const ratio = audioEl.currentTime / audioEl.duration;
      const x = ratio * WIDTH;

      // Clear previous overlay (we redraw entire waveform each time, so need to re-draw)
      // Easiest: re-draw the waveform each interval, then draw ticker line on top.
      drawWaveform(audioEl, canvasEl).then(() => {
        ctx.strokeStyle = 'yellow';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, HEIGHT);
        ctx.stroke();
      });
    }, 100);
  }

  function stopTicker() {
    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
  }
}

// Draw waveform for an <audio> element on a canvas
async function drawWaveform(audioEl, canvasEl) {
  const ctx = canvasEl.getContext('2d');
  const WIDTH = canvasEl.width;
  const HEIGHT = canvasEl.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const response = await fetch(audioEl.src);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const rawData = audioBuffer.getChannelData(0); // assume mono or use channel 0
  const samples = WIDTH; // number of samples in width
  const blockSize = Math.floor(rawData.length / samples); // number of samples per block
  const filteredData = [];
  for (let i = 0; i < samples; i++) {
    let blockStart = i * blockSize;
    let sum = 0;
    for (let j = 0; j < blockSize; j++) {
      sum += Math.abs(rawData[blockStart + j]);
    }
    filteredData.push(sum / blockSize);
  }
  // Normalize
  const multiplier = HEIGHT / Math.max(...filteredData);
  ctx.fillStyle = '#0f0';
  filteredData.forEach((val, i) => {
    const x = i;
    const y = HEIGHT - val * multiplier;
    ctx.fillRect(x, y, 1, val * multiplier);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  displayRecordings();
});