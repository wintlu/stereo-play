import { AudioManager } from './AudioManager.js';
import { SyncManager } from './SyncManager.js';
import { WebSocketClient } from './WebSocketClient.js';

// State
let audioManager = null;
let syncManager = null;
let wsClient = null;
let myChannel = null;
let myClientId = null;
let currentTitle = '';
let currentTrackId = null;
let isLoading = false;
let pendingAudioUrl = null;
let trackList = [];
let playMode = 'sequence'; // 'loop' or 'sequence'

// DOM Elements
const elements = {
  sessionId: null,
  sessionLink: null,
  copyBtn: null,
  linkInput: null,
  submitBtn: null,
  channelDisplay: null,
  clientList: null,
  trackTitle: null,
  playBtn: null,
  pauseBtn: null,
  progressBar: null,
  progressFill: null,
  currentTime: null,
  duration: null,
  status: null,
  volume: null,
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
  elements.channelDisplay = document.getElementById('channel-display');
  elements.clientList = document.getElementById('client-list');
  elements.trackTitle = document.getElementById('track-title');
  elements.playBtn = document.getElementById('play-btn');
  elements.pauseBtn = document.getElementById('pause-btn');
  elements.progressBar = document.getElementById('progress-bar');
  elements.progressFill = document.getElementById('progress-fill');
  elements.currentTime = document.getElementById('current-time');
  elements.duration = document.getElementById('duration');
  elements.status = document.getElementById('status');
  elements.volume = document.getElementById('volume');
  elements.debugLog = document.getElementById('debug-log');
  elements.clearDebug = document.getElementById('clear-debug');
  elements.playlist = document.getElementById('playlist');
  elements.trackCount = document.getElementById('track-count');
  elements.loopBtn = document.getElementById('loop-btn');
  elements.sequenceBtn = document.getElementById('sequence-btn');

  // Clear debug button
  elements.clearDebug?.addEventListener('click', () => {
    if (elements.debugLog) elements.debugLog.innerHTML = '';
  });

  // Playback mode buttons
  elements.loopBtn?.addEventListener('click', () => setPlayMode('loop'));
  elements.sequenceBtn?.addEventListener('click', () => setPlayMode('sequence'));
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
    updateChannelDisplay();
    setStatus(`Connected as ${msg.channel} channel`);
    debugLog(`Joined as ${msg.channel} channel (client: ${msg.clientId})`, 'info');

    // Start latency measurement
    syncManager.startPinging((ts) => wsClient.ping(ts));
  });

  wsClient.on('pong', (msg) => {
    syncManager.handlePong(msg.serverTimestamp, msg.clientTimestamp);
  });

  wsClient.on('audio_loading', (msg) => {
    isLoading = true;
    setStatus('Downloading audio from YouTube... (this may take a moment)');
    elements.submitBtn.disabled = true;
    elements.trackTitle.textContent = 'Downloading...';
    console.log('[Status] Loading audio:', msg.url);
  });

  wsClient.on('audio_ready', async (msg) => {
    isLoading = false;
    currentTitle = msg.title;
    currentTrackId = msg.trackId;
    pendingAudioUrl = msg.audioUrl;
    elements.trackTitle.textContent = msg.title;
    elements.duration.textContent = formatTime(msg.duration);
    elements.submitBtn.disabled = false;
    debugLog(`Audio ready: "${msg.title}" (${msg.audioUrl})`, 'info');

    // Update playlist highlighting
    updatePlaylistHighlight();

    // Try to load audio automatically
    try {
      setStatus(`Loading ${myChannel || 'your'} channel audio...`);
      debugLog('Attempting to load audio...', 'info');
      await audioManager.loadAudio(msg.audioUrl);
      wsClient.sendReady();
      setStatus(`Ready to play (${myChannel} channel)`);
      enableControls(true);
      debugLog('Audio loaded successfully!', 'info');
    } catch (err) {
      debugLog(`Audio load failed: ${err.message}`, 'error');
      // Enable play button - it will handle loading on click
      setStatus('Click Play to start');
      elements.playBtn.disabled = false;
    }
  });

  wsClient.on('track_list', (msg) => {
    trackList = msg.tracks;
    renderPlaylist();
    debugLog(`Received ${msg.tracks.length} tracks`, 'info');
  });

  wsClient.on('play', (msg) => {
    if (!audioManager.isReady()) return;

    const scheduledTime = syncManager.serverTimeToLocal(msg.serverTimestamp);
    audioManager.playAt(msg.startTime, scheduledTime);
    updatePlayState(true);
    startProgressUpdate();
  });

  wsClient.on('pause', (msg) => {
    audioManager.pause();
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

  wsClient.on('error', (msg) => {
    setStatus(`Error: ${msg.message}`);
    debugLog(`Server error: ${msg.message}`, 'error');
    isLoading = false;
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

  // Play/Pause
  elements.playBtn.addEventListener('click', async () => {
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
        enableControls(true);
        debugLog('Audio loaded via Play button', 'info');
      } catch (err) {
        debugLog(`Failed to load: ${err.message}`, 'error');
        elements.playBtn.textContent = 'Play';
        elements.playBtn.disabled = false;
        return;
      }
    }
    wsClient.requestPlay();
  });

  elements.pauseBtn.addEventListener('click', () => {
    wsClient.requestPause();
  });

  // Seek (click on progress bar)
  elements.progressBar.addEventListener('click', (e) => {
    const rect = elements.progressBar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const targetTime = percent * audioManager.getDuration();
    wsClient.requestSeek(targetTime);
  });

  // Volume
  elements.volume.addEventListener('input', (e) => {
    audioManager.setVolume(e.target.value / 100);
  });

  // Audio ended
  window.addEventListener('audio-ended', () => {
    updatePlayState(false);
    stopProgressUpdate();
    // Auto-play next track in playlist
    playNextTrack();
  });
}

function submitLink() {
  const url = elements.linkInput.value.trim();
  console.log('[Submit] URL:', url);

  if (!url) {
    setStatus('Please enter a URL');
    return;
  }

  if (!isYouTubeUrl(url)) {
    setStatus('Please enter a valid YouTube URL');
    console.log('[Submit] Invalid YouTube URL');
    return;
  }

  console.log('[Submit] Sending to server...');
  setStatus('Sending request...');
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
        <span class="client-channel channel-${c.channel}">${c.channel.toUpperCase()}</span>
        <span class="client-status ${c.ready ? 'ready' : ''}">${c.ready ? 'Ready' : 'Loading...'}</span>
        ${c.id === myClientId ? '<span class="client-me-label">(you)</span>' : ''}
      </div>
    `
    )
    .join('');
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
  const duration = audioManager.getDuration();
  const percent = duration > 0 ? (current / duration) * 100 : 0;

  elements.progressFill.style.width = `${percent}%`;
  elements.currentTime.textContent = formatTime(current);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function setStatus(text) {
  elements.status.textContent = text;
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 6);
}

function renderPlaylist() {
  if (!elements.playlist) return;

  elements.trackCount.textContent = `${trackList.length} tracks`;

  if (trackList.length === 0) {
    elements.playlist.innerHTML = '<div class="playlist-empty">No tracks yet. Paste a YouTube link to add one!</div>';
    return;
  }

  elements.playlist.innerHTML = trackList
    .map(
      (track, index) => `
      <div class="playlist-item ${track.id === currentTrackId ? 'active' : ''}" data-track-id="${track.id}">
        <span class="track-number">${index + 1}</span>
        <div class="track-info">
          <div class="track-title">${escapeHtml(track.title)}</div>
        </div>
        <span class="track-duration">${formatTime(track.duration)}</span>
      </div>
    `
    )
    .join('');

  // Add click handlers
  elements.playlist.querySelectorAll('.playlist-item').forEach((item) => {
    item.addEventListener('click', () => {
      const trackId = item.dataset.trackId;
      loadTrack(trackId);
    });
  });
}

function updatePlaylistHighlight() {
  if (!elements.playlist) return;

  elements.playlist.querySelectorAll('.playlist-item').forEach((item) => {
    const isActive = item.dataset.trackId === currentTrackId;
    item.classList.toggle('active', isActive);
  });
}

function loadTrack(trackId) {
  debugLog(`Loading track: ${trackId}`, 'send');
  wsClient.send({ type: 'load_track', trackId });
}

function playNextTrack() {
  if (trackList.length === 0) return;

  if (playMode === 'loop') {
    // Loop current track - just replay from start
    if (currentTrackId) {
      debugLog(`Looping: ${currentTitle}`, 'info');
      wsClient.requestPlay();
    }
  } else {
    // Sequence mode - play next track
    const currentIndex = trackList.findIndex((t) => t.id === currentTrackId);
    const nextIndex = (currentIndex + 1) % trackList.length;
    const nextTrack = trackList[nextIndex];

    if (nextTrack) {
      debugLog(`Playing next: ${nextTrack.title}`, 'info');
      loadTrack(nextTrack.id);
    }
  }
}

function setPlayMode(mode) {
  playMode = mode;
  elements.loopBtn?.classList.toggle('active', mode === 'loop');
  elements.sequenceBtn?.classList.toggle('active', mode === 'sequence');
  debugLog(`Play mode: ${mode}`, 'info');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
