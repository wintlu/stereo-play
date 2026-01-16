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
  }

  async init() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      console.log('[AudioManager] AudioContext state:', this.audioContext.state);
    } catch (e) {
      console.error('[AudioManager] Failed to create AudioContext:', e);
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
    this.sourceNode.connect(this.gainNode);

    // Handle track end
    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pauseTime = 0;
        window.dispatchEvent(new CustomEvent('audio-ended'));
      }
    };

    this.startTime = this.audioContext.currentTime - fromTime;
    this.sourceNode.start(0, fromTime);
    this.isPlaying = true;
    console.log('[AudioManager] Playing from:', fromTime);
  }

  playAt(fromTime, scheduledTime) {
    if (!this.audioBuffer) return;

    // Resume if suspended
    if (this.audioContext.state === 'suspended') {
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
    this.sourceNode.connect(this.gainNode);

    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pauseTime = 0;
        window.dispatchEvent(new CustomEvent('audio-ended'));
      }
    };

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
