import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { SessionManager, ClientInfo, Session } from '../services/SessionManager.js';
import { AudioProcessor } from '../services/AudioProcessor.js';

interface ClientContext {
  sessionId: string;
  clientId: string;
}

type ServerMessage =
  | { type: 'session_joined'; sessionId: string; clientId: string; channel: string }
  | { type: 'audio_ready'; audioUrl: string; duration: number; title: string }
  | { type: 'audio_loading'; url: string }
  | { type: 'play'; startTime: number; serverTimestamp: number }
  | { type: 'pause'; currentTime: number; serverTimestamp: number }
  | { type: 'seek'; targetTime: number; serverTimestamp: number }
  | { type: 'pong'; serverTimestamp: number; clientTimestamp: number }
  | { type: 'client_list'; clients: Array<{ id: string; channel: string; ready: boolean }> }
  | { type: 'error'; message: string };

type ClientMessage =
  | { type: 'join_session'; sessionId: string }
  | { type: 'submit_link'; url: string }
  | { type: 'ready' }
  | { type: 'play_request' }
  | { type: 'pause_request' }
  | { type: 'seek_request'; targetTime: number }
  | { type: 'ping'; clientTimestamp: number };

export function setupWebSocket(
  app: FastifyInstance,
  sessionManager: SessionManager,
  audioProcessor: AudioProcessor
) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const ws = socket as unknown as WebSocket;
    let ctx: ClientContext | null = null;

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        await handleMessage(ws, message, ctx, sessionManager, audioProcessor, (newCtx) => {
          ctx = newCtx;
        });
      } catch (err) {
        console.error('WebSocket message error:', err);
        send(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      if (ctx) {
        sessionManager.removeClient(ctx.sessionId, ctx.clientId);
        // Notify remaining clients
        sessionManager.broadcastToSession(ctx.sessionId, {
          type: 'client_list',
          clients: sessionManager.getClientList(ctx.sessionId),
        });
      }
    });
  });
}

async function handleMessage(
  ws: WebSocket,
  message: ClientMessage,
  ctx: ClientContext | null,
  sessionManager: SessionManager,
  audioProcessor: AudioProcessor,
  setCtx: (ctx: ClientContext) => void
) {
  switch (message.type) {
    case 'join_session': {
      const { sessionId } = message;
      const client = sessionManager.addClient(sessionId, ws);
      const newCtx = { sessionId, clientId: client.id };
      setCtx(newCtx);

      console.log(`[WS] Client ${client.id} joined session ${sessionId} as ${client.assignedChannel}`);

      // Send join confirmation
      send(ws, {
        type: 'session_joined',
        sessionId,
        clientId: client.id,
        channel: client.assignedChannel,
      });

      // Send current audio state if exists
      const session = sessionManager.getSession(sessionId);
      console.log(`[WS] Session ${sessionId} has audioSource:`, !!session?.audioSource);
      if (session?.audioSource) {
        const audioUrl = getAudioUrlForChannel(session, client.assignedChannel);
        console.log(`[WS] Sending audio_ready to new client: ${session.audioSource.title}`);
        send(ws, {
          type: 'audio_ready',
          audioUrl,
          duration: session.audioSource.duration,
          title: session.audioSource.title,
        });
      }

      // Broadcast updated client list
      sessionManager.broadcastToSession(sessionId, {
        type: 'client_list',
        clients: sessionManager.getClientList(sessionId),
      });
      break;
    }

    case 'submit_link': {
      if (!ctx) return;
      const { url } = message;

      // Validate YouTube URL
      if (!isYouTubeUrl(url)) {
        send(ws, { type: 'error', message: 'Only YouTube URLs are supported' });
        return;
      }

      // Notify all clients that audio is loading
      sessionManager.broadcastToSession(ctx.sessionId, {
        type: 'audio_loading',
        url,
      });

      try {
        // Process the audio
        const processed = await audioProcessor.processYouTubeUrl(url);

        // Update session
        sessionManager.setAudioSource(ctx.sessionId, {
          url,
          title: processed.title,
          duration: processed.duration,
          files: processed.files,
        });

        // Reset ready state for all clients
        const session = sessionManager.getSession(ctx.sessionId);
        if (session) {
          for (const client of session.clients.values()) {
            client.isReady = false;
            // Send each client their channel-specific audio URL
            const audioUrl = getAudioUrlForChannel(session, client.assignedChannel);
            sendTo(client, {
              type: 'audio_ready',
              audioUrl,
              duration: processed.duration,
              title: processed.title,
            });
          }
        }
      } catch (err) {
        console.error('Audio processing error:', err);
        send(ws, { type: 'error', message: 'Failed to process audio' });
      }
      break;
    }

    case 'ready': {
      if (!ctx) return;
      sessionManager.setClientReady(ctx.sessionId, ctx.clientId, true);

      // Broadcast updated client list
      sessionManager.broadcastToSession(ctx.sessionId, {
        type: 'client_list',
        clients: sessionManager.getClientList(ctx.sessionId),
      });
      break;
    }

    case 'play_request': {
      if (!ctx) return;
      const session = sessionManager.getSession(ctx.sessionId);
      if (!session?.audioSource) return;

      const serverTimestamp = Date.now();
      const scheduledTime = serverTimestamp + 500; // Schedule 500ms in future

      sessionManager.updatePlaybackState(ctx.sessionId, {
        isPlaying: true,
        lastSyncTimestamp: serverTimestamp,
      });

      // Broadcast play command with synchronized timestamp
      for (const client of session.clients.values()) {
        const adjustedTime = scheduledTime - (client.latency / 2);
        sendTo(client, {
          type: 'play',
          startTime: session.playbackState.currentTime,
          serverTimestamp: adjustedTime,
        });
      }
      break;
    }

    case 'pause_request': {
      if (!ctx) return;
      const session = sessionManager.getSession(ctx.sessionId);
      if (!session) return;

      const serverTimestamp = Date.now();

      sessionManager.updatePlaybackState(ctx.sessionId, {
        isPlaying: false,
        lastSyncTimestamp: serverTimestamp,
      });

      sessionManager.broadcastToSession(ctx.sessionId, {
        type: 'pause',
        currentTime: session.playbackState.currentTime,
        serverTimestamp,
      });
      break;
    }

    case 'seek_request': {
      if (!ctx) return;
      const { targetTime } = message;
      const serverTimestamp = Date.now();

      sessionManager.updatePlaybackState(ctx.sessionId, {
        currentTime: targetTime,
        lastSyncTimestamp: serverTimestamp,
      });

      sessionManager.broadcastToSession(ctx.sessionId, {
        type: 'seek',
        targetTime,
        serverTimestamp,
      });
      break;
    }

    case 'ping': {
      if (!ctx) return;
      const { clientTimestamp } = message;
      const serverTimestamp = Date.now();

      // Calculate and store latency (rough estimate)
      const latency = serverTimestamp - clientTimestamp;
      sessionManager.setClientLatency(ctx.sessionId, ctx.clientId, Math.max(0, latency));

      send(ws, {
        type: 'pong',
        serverTimestamp,
        clientTimestamp,
      });
      break;
    }
  }
}

function getAudioUrlForChannel(session: Session, channel: string): string {
  if (!session.audioSource) return '';
  switch (channel) {
    case 'left':
      return session.audioSource.files.left;
    case 'right':
      return session.audioSource.files.right;
    default:
      return session.audioSource.files.stereo;
  }
}

function send(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function sendTo(client: ClientInfo, message: ServerMessage) {
  send(client.websocket, message);
}

function isYouTubeUrl(url: string): boolean {
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
