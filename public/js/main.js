import { AudioManager } from './AudioManager.js';
import { SyncManager } from './SyncManager.js';
import { WebSocketClient } from './WebSocketClient.js';
import { StatusMachine } from './StatusMachine.js';

// State
let audioManager = null;
let syncManager = null;
let wsClient = null;
let statusMachine = null;
let myChannel = null;
let myClientId = null;
let currentTitle = '';
let pendingAudioUrl = null;
let serverDuration = 0; // Duration from server (full track length)

// DOM Elements
const elements = {
  sessionId: null,
  sessionLink: null,
  copyBtn: null,
  linkInput: null,
  submitBtn: null,
  inputSection: null,
  channelDisplay: null,
  clientList: null,
  trackTitle: null,
  // Controls (all clients see these in peer model)
  playBtn: null,
  pauseBtn: null,
  // Progress
  progressBar: null,
  progressFill: null,
  currentTime: null,
  duration: null,
  status: null,
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initElements();
  initSession();
  initEventListeners();
});

function initElements() {
  elements.sessionId = document.getElementById('session-id');
  elements.sessionLink = document.getElementById('session-link');
  elements.copyBtn = document.getElementById('copy-btn');
  elements.linkInput = document.getElementById('link-input');
  elements.submitBtn = document.getElementById('submit-btn');
  elements.inputSection = document.querySelector('.input-section');
  elements.channelDisplay = document.getElementById('channel-display');
  elements.clientList = document.getElementById('client-list');
  elements.trackTitle = document.getElementById('track-title');
  // Controls (all clients see these in peer model)
  elements.playBtn = document.getElementById('play-btn');
  elements.pauseBtn = document.getElementById('pause-btn');
  // Progress
  elements.progressBar = document.getElementById('progress-bar');
  elements.progressFill = document.getElementById('progress-fill');
  elements.currentTime = document.getElementById('current-time');
  elements.duration = document.getElementById('duration');
  elements.status = document.getElementById('status');
  elements.debugLog = document.getElementById('debug-log');
  elements.clearDebug = document.getElementById('clear-debug');
  elements.copyDebug = document.getElementById('copy-debug');

  // Clear debug button
  elements.clearDebug?.addEventListener('click', () => {
    if (elements.debugLog) elements.debugLog.innerHTML = '';
  });

  // Copy debug button (with iOS fallback)
  elements.copyDebug?.addEventListener('click', () => {
    if (elements.debugLog) {
      const text = elements.debugLog.innerText;
      copyToClipboard(text).then((success) => {
        elements.copyDebug.textContent = success ? 'Copied!' : 'Failed';
        setTimeout(() => {
          elements.copyDebug.textContent = 'Copy';
        }, 2000);
      });
    }
  });
}

function debugLog(message, type = 'info') {
  if (!elements.debugLog) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  elements.debugLog.appendChild(entry);
  elements.debugLog.scrollTop = elements.debugLog.scrollHeight;
}

function initSession() {
  // Get or create session ID from URL
  const params = new URLSearchParams(window.location.search);
  let sessionId = params.get('session');

  if (!sessionId) {
    sessionId = generateSessionId();
    window.history.replaceState({}, '', `?session=${sessionId}`);
  }

  elements.sessionId.textContent = sessionId;
  elements.sessionLink.value = window.location.href;

  // Listen for audio manager logs
  window.addEventListener('audio-log', (e) => {
    debugLog(e.detail.message, e.detail.type);
  });

  // Initialize managers
  audioManager = new AudioManager();
  syncManager = new SyncManager();
  wsClient = new WebSocketClient();

  // Set up WebSocket handlers
  setupWebSocketHandlers();

  // Connect
  wsClient.connect(sessionId);
}

function setupWebSocketHandlers() {
  // Log ALL incoming messages for debugging
  const originalHandleMessage = wsClient.handleMessage.bind(wsClient);
  wsClient.handleMessage = (message) => {
    // Skip noisy pong messages in debug log
    if (message.type !== 'pong') {
      debugLog(`← ${message.type}: ${JSON.stringify(message)}`, 'receive');
    }
    console.log('[WS] Received:', message.type, message);
    originalHandleMessage(message);
  };

  // Also log outgoing messages
  const originalSend = wsClient.send.bind(wsClient);
  wsClient.send = (message) => {
    // Skip noisy ping messages in debug log
    if (message.type !== 'ping') {
      debugLog(`→ ${message.type}: ${JSON.stringify(message)}`, 'send');
    }
    originalSend(message);
  };

  wsClient.on('session_joined', (msg) => {
    myClientId = msg.clientId;
    myChannel = msg.channel;

    // Initialize status machine (same for all clients in peer model)
    statusMachine = new StatusMachine();
    statusMachine.onChange(updateStatusDisplay);

    updateChannelDisplay();
    debugLog(`Joined as ${msg.channel} channel (client: ${msg.clientId})`, 'info');

    // Start latency measurement
    syncManager.startPinging((ts) => wsClient.ping(ts));
  });

  wsClient.on('pong', (msg) => {
    syncManager.handlePong(msg.serverTimestamp, msg.clientTimestamp);
  });

  wsClient.on('audio_loading', (msg) => {
    statusMachine.send('LOAD');
    if (elements.submitBtn) elements.submitBtn.disabled = true;
    elements.trackTitle.textContent = 'Processing...';
    console.log('[Status] Loading audio:', msg.url);
  });

  wsClient.on('audio_ready', async (msg) => {
    currentTitle = msg.title;
    pendingAudioUrl = msg.audioUrl;
    serverDuration = msg.duration; // Store full duration from server
    elements.trackTitle.textContent = msg.title;
    elements.duration.textContent = formatTime(msg.duration);
    if (elements.submitBtn) elements.submitBtn.disabled = false;
    debugLog(`Audio ready: "${msg.title}" (${msg.audioUrl}), duration: ${msg.duration}s`, 'info');

    // Try to load audio automatically
    try {
      debugLog('Attempting to load audio...', 'info');
      await audioManager.loadAudio(msg.audioUrl);
      wsClient.sendReady();
      statusMachine.send('AUTO_READY');
      debugLog(`Audio loaded successfully!`, 'info');
    } catch (err) {
      debugLog(`Audio load failed (iOS?) - will load on Play click: ${err.message}`, 'info');
      // Play button will handle iOS unlock when clicked
      statusMachine.send('AUTO_READY');
    }
    enableControls(true);
  });

  wsClient.on('play', (msg) => {
    if (!audioManager.isReady()) return;

    const scheduledTime = syncManager.serverTimeToLocal(msg.serverTimestamp);
    audioManager.playAt(msg.startTime, scheduledTime);
    statusMachine.send('PLAY');
    updatePlayState(true);
    startProgressUpdate();
  });

  wsClient.on('pause', (msg) => {
    audioManager.pause();
    statusMachine.send('PAUSE');
    updatePlayState(false);
    stopProgressUpdate();
  });

  wsClient.on('seek', (msg) => {
    audioManager.seekTo(msg.targetTime);
    updateProgress();
  });

  wsClient.on('client_list', (msg) => {
    updateClientList(msg.clients);
  });

  wsClient.on('volume_change', (msg) => {
    // Received volume change from another client
    debugLog(`Volume change received: ${msg.volume}%`, 'receive');
    audioManager.setVolume(msg.volume / 100);
  });

  wsClient.on('error', (msg) => {
    statusMachine.send('ERROR');
    debugLog(`Server error: ${msg.message}`, 'error');
    elements.submitBtn.disabled = false;
    elements.trackTitle.textContent = 'Error - try again';
  });
}

function initEventListeners() {
  // Copy session link
  elements.copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(elements.sessionLink.value);
    elements.copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      elements.copyBtn.textContent = 'Copy';
    }, 2000);
  });

  // Submit YouTube link
  elements.submitBtn.addEventListener('click', submitLink);
  elements.linkInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitLink();
  });

  // Play/Pause - all clients can control in peer model
  elements.playBtn.addEventListener('click', async () => {
    debugLog('Play button clicked', 'info');

    try {
      // If audio not loaded yet, try to load it first
      if (!audioManager.isReady() && pendingAudioUrl) {
        try {
          elements.playBtn.disabled = true;
          elements.playBtn.textContent = 'Loading...';
          await audioManager.resumeContext();
          await audioManager.loadAudio(pendingAudioUrl);
          wsClient.sendReady();
          elements.playBtn.textContent = 'Play';
          elements.playBtn.disabled = false;
          debugLog('Audio loaded via Play button', 'info');
        } catch (err) {
          debugLog(`Failed to load: ${err.message}`, 'error');
          elements.playBtn.textContent = 'Play';
          elements.playBtn.disabled = false;
          return;
        }
      }

      debugLog('Sending play_request to server', 'info');
      wsClient.requestPlay();
    } catch (err) {
      debugLog(`Play error: ${err.message}`, 'error');
    }
  });

  elements.pauseBtn.addEventListener('click', () => {
    wsClient.requestPause();
  });

  // Seek (click on progress bar) - all clients can seek in peer model
  elements.progressBar.addEventListener('click', (e) => {
    const rect = elements.progressBar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    // Use server duration for accurate seek calculation
    const duration = serverDuration > 0 ? serverDuration : audioManager.getDuration();
    const targetTime = percent * duration;
    wsClient.requestSeek(targetTime);
  });

}

function submitLink() {
  const url = elements.linkInput.value.trim();
  console.log('[Submit] URL:', url);

  if (!url) {
    debugLog('No URL entered', 'error');
    return;
  }

  if (!isYouTubeUrl(url)) {
    debugLog('Invalid YouTube URL', 'error');
    console.log('[Submit] Invalid YouTube URL');
    return;
  }

  console.log('[Submit] Sending to server...');
  statusMachine.send('LOAD');
  wsClient.submitLink(url);
  elements.linkInput.value = '';
}

function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'youtube.com' ||
      parsed.hostname === 'www.youtube.com' ||
      parsed.hostname === 'youtu.be' ||
      parsed.hostname === 'm.youtube.com'
    );
  } catch {
    return false;
  }
}

function updateChannelDisplay() {
  const channelNames = {
    left: 'LEFT',
    right: 'RIGHT',
    stereo: 'STEREO',
  };
  elements.channelDisplay.textContent = channelNames[myChannel] || myChannel;
  elements.channelDisplay.className = `channel-badge channel-${myChannel}`;
}


function updateClientList(clients) {
  elements.clientList.innerHTML = clients
    .map(
      (c) => `
      <div class="client ${c.id === myClientId ? 'client-me' : ''}">
        <div class="client-info">
          <span class="client-channel channel-${c.channel}">${c.channel.toUpperCase()}</span>
          <span class="client-status ${c.ready ? 'ready' : ''}">${c.ready ? 'Ready' : 'Loading...'}</span>
          ${c.id === myClientId ? '<span class="client-me-label">(you)</span>' : ''}
        </div>
        <div class="client-volume">
          <input type="range" class="volume-slider" data-channel="${c.channel}" min="0" max="100" value="100">
        </div>
      </div>
    `
    )
    .join('');

  // Attach volume slider event listeners
  elements.clientList.querySelectorAll('.volume-slider').forEach((slider) => {
    slider.addEventListener('input', (e) => {
      const channel = e.target.dataset.channel;
      const volume = parseInt(e.target.value);
      wsClient.send({ type: 'volume_request', channel, volume });
    });
  });
}

function updatePlayState(playing) {
  elements.playBtn.style.display = playing ? 'none' : 'inline-block';
  elements.pauseBtn.style.display = playing ? 'inline-block' : 'none';
}

function enableControls(enabled) {
  elements.playBtn.disabled = !enabled;
  elements.pauseBtn.disabled = !enabled;
  elements.progressBar.style.pointerEvents = enabled ? 'auto' : 'none';
}

let progressInterval = null;

function startProgressUpdate() {
  stopProgressUpdate();
  progressInterval = setInterval(updateProgress, 100);
}

function stopProgressUpdate() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

function updateProgress() {
  const current = audioManager.getCurrentTime();
  // Use server duration (full track) instead of buffer duration (partial download)
  const duration = serverDuration > 0 ? serverDuration : audioManager.getDuration();
  const percent = duration > 0 ? (current / duration) * 100 : 0;

  elements.progressFill.style.width = `${percent}%`;
  elements.currentTime.textContent = formatTime(current);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Update status display based on state machine state
 * @param {string} state - Current state
 * @param {string} label - Display label for the state
 */
function updateStatusDisplay(state, label) {
  if (!elements.status) return;
  elements.status.textContent = label;
  elements.status.className = `status status-${state}`;
  debugLog(`Status: ${state} (${label})`, 'info');
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 6);
}

// iOS-compatible clipboard copy
async function copyToClipboard(text) {
  // Try modern API first
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fall through to fallback
    }
  }

  // Fallback for iOS and older browsers
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.setAttribute('readonly', ''); // Prevent zoom on iOS
    document.body.appendChild(textarea);

    // iOS specific selection
    const range = document.createRange();
    range.selectNodeContents(textarea);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    textarea.setSelectionRange(0, text.length); // For iOS

    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch (e) {
    console.error('Copy failed:', e);
    return false;
  }
}
