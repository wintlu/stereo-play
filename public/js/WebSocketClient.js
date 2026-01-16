export class WebSocketClient {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.sessionId = null;
  }

  connect(sessionId) {
    this.sessionId = sessionId;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WebSocket] Connected');
      this.reconnectAttempts = 0;
      this.send({ type: 'join_session', sessionId });
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (err) {
        console.error('[WebSocket] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[WebSocket] Disconnected');
      this.tryReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WebSocket] Error:', err);
    };
  }

  tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WebSocket] Max reconnect attempts reached');
      if (this.handlers.error) {
        this.handlers.error({ message: 'Connection lost. Please refresh the page.' });
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    console.log(`[WebSocket] Reconnecting in ${delay}ms...`);

    setTimeout(() => {
      if (this.sessionId) {
        this.connect(this.sessionId);
      }
    }, delay);
  }

  handleMessage(message) {
    const handler = this.handlers[message.type];
    if (handler) {
      handler(message);
    } else {
      console.log('[WebSocket] Unhandled message:', message.type);
    }
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  submitLink(url) {
    this.send({ type: 'submit_link', url });
  }

  sendReady() {
    this.send({ type: 'ready' });
  }

  requestPlay() {
    this.send({ type: 'play_request' });
  }

  requestPause() {
    this.send({ type: 'pause_request' });
  }

  requestSeek(targetTime) {
    this.send({ type: 'seek_request', targetTime });
  }

  ping(clientTimestamp) {
    this.send({ type: 'ping', clientTimestamp });
  }
}
