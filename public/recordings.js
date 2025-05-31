/**
 * recordings.js
 *
 * - Fetches GET /recordings to retrieve a JSON array of filenames.
 * - For each recording:
 *   • Creates a `.recording-entry` with:
 *     - <div class="recording-title">filename</div>
 *     - <div class="waveform-container">
 *         <canvas class="waveform-canvas" width="800" height="200"></canvas>
 *         <div class="ticker"></div>
 *       </div>
 *     - <div class="controls">
 *         <audio controls preload="none"></audio>
 *         <button class="playPauseBtn">Play</button>
 *         <span class="timeDisplay">00:00 / 00:00</span>
 *       </div>
 *   • Fetches the audio file as an ArrayBuffer, decodes via Web Audio API, draws full waveform on canvas.
 *   • Hooks up the <audio> element’s `timeupdate` to move the ticker across the canvas.
 */

(async () => {
  const recordingsContainer = document.getElementById('recordingsContainer');

  // 1) Fetch the list of recordings
  async function fetchRecordingsList() {
    try {
      const resp = await fetch('/recordings');
      const json = await resp.json();
      return json.recordings || [];
    } catch (err) {
      console.error('Error fetching recordings list:', err);
      return [];
    }
  }

  // 2) For each filename, create UI entry
  async function renderRecording(filename) {
    const entryEl = document.createElement('div');
    entryEl.className = 'recording-entry';

    const titleEl = document.createElement('div');
    titleEl.className = 'recording-title';
    titleEl.textContent = filename;
    entryEl.appendChild(titleEl);

    // Waveform container
    const wfContainer = document.createElement('div');
    wfContainer.className = 'waveform-container';
    wfContainer.style.width = '800px';
    wfContainer.style.height = '200px';
    wfContainer.style.position = 'relative';

    const canvas = document.createElement('canvas');
    canvas.className = 'waveform-canvas';
    canvas.width = 800;
    canvas.height = 200;
    wfContainer.appendChild(canvas);

    const ticker = document.createElement('div');
    ticker.className = 'ticker';
    ticker.style.left = '0px';
    wfContainer.appendChild(ticker);

    entryEl.appendChild(wfContainer);

    // Controls: audio element + play/pause button + time display
    const controlsEl = document.createElement('div');
    controlsEl.className = 'controls';

    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    audioEl.preload = 'none';
    audioEl.src = `/recordings/${encodeURIComponent(filename)}`;
    controlsEl.appendChild(audioEl);

    const playPauseBtn = document.createElement('button');
    playPauseBtn.textContent = 'Play';
    controlsEl.appendChild(playPauseBtn);

    const timeDisplay = document.createElement('span');
    timeDisplay.className = 'timeDisplay';
    timeDisplay.textContent = '00:00 / 00:00';
    timeDisplay.style.marginLeft = '10px';
    controlsEl.appendChild(timeDisplay);

    entryEl.appendChild(controlsEl);

    recordingsContainer.appendChild(entryEl);

    // Draw waveform once we have the ArrayBuffer
    try {
      const arrayBuffer = await fetch(`/recordings/${encodeURIComponent(filename)}`).then((r) =>
        r.arrayBuffer()
      );
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      drawFullWaveform(canvas, audioBuffer);
      setupTicker(canvas, ticker, audioEl, timeDisplay, audioBuffer.duration);
    } catch (err) {
      console.error(`Error loading or decoding ${filename}:`, err);
    }

    // Play/pause button toggles playback
    playPauseBtn.onclick = () => {
      if (audioEl.paused) {
        audioEl.play();
        playPauseBtn.textContent = 'Pause';
      } else {
        audioEl.pause();
        playPauseBtn.textContent = 'Play';
      }
    };

    // Sync time display and ticker when user clicks on <audio> controls
    audioEl.ontimeupdate = () => {
      updateTimeDisplay(timeDisplay, audioEl.currentTime, audioEl.duration);
      updateTickerPosition(ticker, canvas, audioEl.currentTime, audioEl.duration);
    };
    audioEl.onended = () => {
      playPauseBtn.textContent = 'Play';
    };
  }

  // Draw the entire waveform into the canvas
  function drawFullWaveform(canvas, audioBuffer) {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, width, height);

    const channelData = audioBuffer.numberOfChannels > 1
      ? mixDownToMono(audioBuffer.getChannelData(0), audioBuffer.getChannelData(1))
      : audioBuffer.getChannelData(0);

    const samples = channelData.length;
    const blockSize = Math.floor(samples / width);
    const filteredData = [];
    for (let i = 0; i < width; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum += Math.abs(channelData[i * blockSize + j]);
      }
      filteredData.push(sum / blockSize);
    }
    const multiplier = height / Math.max(...filteredData);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#0f0';
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const x = i;
      const y = height - filteredData[i] * multiplier;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // Helper: if stereo, average two channels into one array
  function mixDownToMono(ch0, ch1) {
    const length = Math.min(ch0.length, ch1.length);
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      mono[i] = (ch0[i] + ch1[i]) / 2;
    }
    return mono;
  }

  // Setup the ticker (vertical line) to move over the waveform
  function setupTicker(canvas, ticker, audioEl, timeDisplay, duration) {
    function update() {
      if (!audioEl.paused) {
        const currentTime = audioEl.currentTime;
        updateTimeDisplay(timeDisplay, currentTime, duration);
        updateTickerPosition(ticker, canvas, currentTime, duration);
      }
      requestAnimationFrame(update);
    }
    update();
  }

  // Move the ticker based on currentTime / duration
  function updateTickerPosition(ticker, canvas, currentTime, duration) {
    const width = canvas.width;
    const pct = duration > 0 ? currentTime / duration : 0;
    ticker.style.left = `${Math.floor(pct * width)}px`;
  }

  // Update the "mm:ss / mm:ss" display
  function updateTimeDisplay(el, currentTime, duration) {
    const curM = String(Math.floor(currentTime / 60)).padStart(2, '0');
    const curS = String(Math.floor(currentTime % 60)).padStart(2, '0');
    const durM = String(Math.floor(duration / 60)).padStart(2, '0');
    const durS = String(Math.floor(duration % 60)).padStart(2, '0');
    el.textContent = `${curM}:${curS} / ${durM}:${durS}`;
  }

  /////////////////////////////////////////////////////
  // Entry point: Fetch list and render
  /////////////////////////////////////////////////////
  window.addEventListener('load', async () => {
    // First, render existing recordings
    const recordingsList = await fetchRecordingsList();
    recordingsList.forEach((filename) => {
      renderRecording(filename);
    });
  });

  /////////////////////////////////////////////////////
  // Fetch recordings list from /recordings
  /////////////////////////////////////////////////////
  async function fetchRecordingsList() {
    try {
      const resp = await fetch('/recordings');
      const json = await resp.json();
      return json.recordings || [];
    } catch (err) {
      console.error('Error fetching recordings list:', err);
      return [];
    }
  }
})();
