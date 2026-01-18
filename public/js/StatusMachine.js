/**
 * State machine for managing client status display.
 * Ensures only valid state transitions occur.
 * All clients use the same state machine (peer model).
 */
export class StatusMachine {
  constructor() {
    this.state = null;
    this.listeners = [];

    // Simple state flow for peer model
    this.transitions = {
      null:     { LOAD: 'loading' },
      loading:  { AUTO_READY: 'ready', ERROR: null, LOAD: 'loading' },
      ready:    { PLAY: 'playing', LOAD: 'loading' },
      playing:  { PAUSE: 'paused', LOAD: 'loading' },
      paused:   { PLAY: 'playing', LOAD: 'loading' },
    };

    // Labels for each state
    this.labels = {
      loading: 'Loading',
      ready: 'Ready',
      playing: 'Playing',
      paused: 'Paused',
    };
  }

  /**
   * Attempt a state transition.
   * @param {string} event - The event triggering the transition
   * @returns {boolean} - Whether the transition was successful
   */
  send(event) {
    const currentTransitions = this.transitions[this.state];
    if (!currentTransitions || !(event in currentTransitions)) {
      console.warn(`[StatusMachine] Invalid transition: ${this.state} + ${event}`);
      return false;
    }

    const newState = currentTransitions[event];
    const oldState = this.state;
    this.state = newState;

    console.log(`[StatusMachine] ${oldState} → ${newState} (${event})`);
    this.notify();
    return true;
  }

  /**
   * Get current state
   * @returns {string|null}
   */
  getState() {
    return this.state;
  }

  /**
   * Get display label for current state
   * @returns {string}
   */
  getLabel() {
    return this.labels[this.state] || '';
  }

  /**
   * Subscribe to state changes
   * @param {function} callback - Called with (newState, label) on state change
   */
  onChange(callback) {
    this.listeners.push(callback);
  }

  /**
   * Notify all listeners of state change
   */
  notify() {
    const label = this.getLabel();
    this.listeners.forEach(cb => cb(this.state, label));
  }

  /**
   * Check if in a specific state
   * @param {string} state
   * @returns {boolean}
   */
  is(state) {
    return this.state === state;
  }

  /**
   * Check if audio can be played (ready or paused)
   * @returns {boolean}
   */
  canPlay() {
    return this.state === 'ready' || this.state === 'paused';
  }

  /**
   * Check if audio is currently playing
   * @returns {boolean}
   */
  isPlaying() {
    return this.state === 'playing';
  }
}
