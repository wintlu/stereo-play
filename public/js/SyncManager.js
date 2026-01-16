export class SyncManager {
  constructor() {
    this.clockOffset = 0;
    this.latencySamples = [];
    this.pingInterval = null;
    this.onPong = null;
  }

  handlePong(serverTimestamp, clientTimestamp) {
    const now = Date.now();
    const rtt = now - clientTimestamp;
    const latency = rtt / 2;
    const offset = serverTimestamp - clientTimestamp - latency;

    this.latencySamples.push({ latency, offset });

    // Keep last 5 samples
    if (this.latencySamples.length > 5) {
      this.latencySamples.shift();
    }

    // Use median offset for stability
    const sorted = [...this.latencySamples].sort((a, b) => a.offset - b.offset);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.clockOffset = median.offset;

    if (this.onPong) {
      this.onPong({ latency, offset: this.clockOffset });
    }
  }

  serverTimeToLocal(serverTime) {
    return serverTime - this.clockOffset;
  }

  localTimeToServer(localTime) {
    return localTime + this.clockOffset;
  }

  scheduleAction(serverTimestamp, action) {
    const localTargetTime = this.serverTimeToLocal(serverTimestamp);
    const delay = localTargetTime - Date.now();

    if (delay > 0) {
      return setTimeout(action, delay);
    } else {
      // Already past target time, execute immediately
      action();
      return null;
    }
  }

  getEstimatedLatency() {
    if (this.latencySamples.length === 0) return 0;
    const sum = this.latencySamples.reduce((acc, s) => acc + s.latency, 0);
    return sum / this.latencySamples.length;
  }

  startPinging(sendPing) {
    // Send initial pings quickly to establish sync
    let count = 0;
    const initialPing = () => {
      sendPing(Date.now());
      count++;
      if (count < 3) {
        setTimeout(initialPing, 200);
      }
    };
    initialPing();

    // Then ping periodically
    this.pingInterval = setInterval(() => {
      sendPing(Date.now());
    }, 5000);
  }

  stopPinging() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
