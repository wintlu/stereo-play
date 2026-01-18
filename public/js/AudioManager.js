export class AudioManager {
  constructor() {
    this.audioContext = null;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.startTime = 0;
    this.pauseTime = 0;
    this.isPlaying = false;
    this.duration = 0;

    // Prevent Chrome from suspending audio in background tabs
    this.setupBackgroundPlayback();
  }

  setupBackgroundPlayback() {
    // Resume AudioContext when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      this.log(`Tab visibility: ${document.visibilityState}, context: ${this.audioContext?.state}`);
      if (document.visibilityState === 'visible' && this.audioContext) {
        if (this.audioContext.state === 'suspended') {
          this.log('Tab visible - resuming suspended AudioContext', 'warn');
          this.audioContext.resume();
        }
      } else if (document.visibilityState === 'hidden') {
        this.log('Tab hidden - audio may be throttled by browser', 'warn');
      }
    });

    // Periodically check and resume suspended context (helps with background tabs)
    setInterval(() => {
      if (this.audioContext && this.isPlaying) {
        if (this.audioContext.state === 'suspended') {
          this.log('AudioContext suspended while playing - resuming', 'error');
          this.audioContext.resume();
        }
      }
    }, 1000);

    // Monitor AudioContext state changes
    this.monitorContextState();
  }

  monitorContextState() {
    if (!this.audioContext) return;

    this.audioContext.onstatechange = () => {
      this.log(`AudioContext state changed: ${this.audioContext.state}`,
        this.audioContext.state === 'suspended' ? 'error' : 'info');
    };
  }

  // Emit log events for debug panel
  log(message, type = 'info') {
    console.log(`[AudioManager] ${message}`);
    window.dispatchEvent(new CustomEvent('audio-log', {
      detail: { message: `[Audio] ${message}`, type }
    }));
  }

  async init() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0; // Ensure full volume
      this.gainNode.connect(this.audioContext.destination);
      this.log(`AudioContext created, state: ${this.audioContext.state}, sample rate: ${this.audioContext.sampleRate}`);
      this.monitorContextState();
    } catch (e) {
      this.log(`Failed to create AudioContext: ${e.message}`, 'error');
      throw e;
    }
  }

  async loadAudio(url) {
    if (!this.audioContext) await this.init();

    console.log('[AudioManager] AudioContext state:', this.audioContext.state);

    // If suspended, need user gesture first - don't even try to resume
    if (this.audioContext.state === 'suspended') {
      console.log('[AudioManager] Suspended - need user gesture');
      throw new Error('Audio blocked - click to enable');
    }

    console.log('[AudioManager] Loading audio:', url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    this.duration = this.audioBuffer.duration;
    this.pauseTime = 0;
    console.log('[AudioManager] Audio loaded, duration:', this.duration);
  }

  async resumeContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      console.log('[AudioManager] Resumed, state:', this.audioContext.state);
    }

    // iOS audio unlock: play a silent buffer to enable future programmatic playback
    await this.unlockAudio();
  }

  async unlockAudio() {
    if (!this.audioContext) return;

    try {
      // Method 1: Silent buffer
      const silentBuffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(this.audioContext.destination);
      source.start(0);

      // Method 2: Silent oscillator (more reliable on some iOS versions)
      const oscillator = this.audioContext.createOscillator();
      const silentGain = this.audioContext.createGain();
      silentGain.gain.value = 0; // Silent
      oscillator.connect(silentGain);
      silentGain.connect(this.audioContext.destination);
      oscillator.start(0);
      oscillator.stop(0.001);

      console.log('[AudioManager] iOS audio unlocked');
    } catch (e) {
      console.log('[AudioManager] Audio unlock failed (may be ok):', e.message);
    }
  }

  play(fromTime = 0) {
    if (!this.audioBuffer || this.isPlaying) return;

    // Resume if suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Create new source node (they're one-time-use)
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.loop = true; // Enable repeat mode
    this.sourceNode.connect(this.gainNode);

    this.startTime = this.audioContext.currentTime - fromTime;
    this.sourceNode.start(0, fromTime);
    this.isPlaying = true;
    console.log('[AudioManager] Playing from:', fromTime);
  }

  playAt(fromTime, scheduledTime) {
    if (!this.audioBuffer) {
      console.log('[AudioManager] playAt: No audio buffer!');
      return;
    }

    console.log('[AudioManager] playAt: context state:', this.audioContext.state, 'gain:', this.gainNode.gain.value);

    // Resume if suspended
    if (this.audioContext.state === 'suspended') {
      console.log('[AudioManager] playAt: Resuming suspended context...');
      this.audioContext.resume();
    }

    // Stop current playback if any
    if (this.sourceNode && this.isPlaying) {
      this.sourceNode.onended = null;
      this.sourceNode.stop();
    }

    // Create new source node
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.loop = true; // Enable repeat mode
    this.sourceNode.connect(this.gainNode);

    // Schedule start at exact time
    const now = this.audioContext.currentTime;
    const delay = Math.max(0, (scheduledTime - Date.now()) / 1000);
    const when = now + delay;

    this.startTime = when - fromTime;
    this.sourceNode.start(when, fromTime);
    this.isPlaying = true;
    console.log('[AudioManager] Scheduled play at:', when, 'from:', fromTime);
  }

  pause() {
    if (!this.sourceNode || !this.isPlaying) return this.pauseTime;

    this.sourceNode.onended = null;
    this.sourceNode.stop();
    this.pauseTime = this.getCurrentTime();
    this.isPlaying = false;
    console.log('[AudioManager] Paused at:', this.pauseTime);
    return this.pauseTime;
  }

  getCurrentTime() {
    if (!this.isPlaying) return this.pauseTime;
    return this.audioContext.currentTime - this.startTime;
  }

  seekTo(time) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.sourceNode.onended = null;
      this.sourceNode.stop();
      this.isPlaying = false;
    }
    this.pauseTime = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) {
      this.play(this.pauseTime);
    }
  }

  setVolume(value) {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, value));
    }
  }

  getDuration() {
    return this.duration;
  }

  isReady() {
    return this.audioBuffer !== null;
  }
}
