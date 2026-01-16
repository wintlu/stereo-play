import { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';

export type Channel = 'left' | 'right' | 'stereo';

export interface ClientInfo {
  id: string;
  websocket: WebSocket;
  assignedChannel: Channel;
  latency: number;
  isReady: boolean;
}

export interface AudioSource {
  url: string;
  title: string;
  duration: number;
  files: {
    stereo: string;
    left: string;
    right: string;
  };
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  lastSyncTimestamp: number;
}

export interface Session {
  id: string;
  createdAt: number;
  audioSource: AudioSource | null;
  playbackState: PlaybackState;
  clients: Map<string, ClientInfo>;
}

// Persisted session data (without WebSocket connections)
interface PersistedSession {
  id: string;
  createdAt: number;
  audioSource: AudioSource | null;
}

interface PersistedState {
  sessions: Record<string, PersistedSession>;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private stateFilePath: string;

  constructor(dataDir: string) {
    this.stateFilePath = path.join(dataDir, 'sessions.json');
    this.loadState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, 'utf-8');
        const state: PersistedState = JSON.parse(data);

        // Restore sessions with audio sources
        for (const [id, persisted] of Object.entries(state.sessions)) {
          if (persisted.audioSource) {
            const session: Session = {
              id: persisted.id,
              createdAt: persisted.createdAt,
              audioSource: persisted.audioSource,
              playbackState: {
                isPlaying: false,
                currentTime: 0,
                lastSyncTimestamp: Date.now(),
              },
              clients: new Map(),
            };
            this.sessions.set(id, session);
            console.log(`[SessionManager] Restored session ${id} with audio: ${persisted.audioSource.title}`);
          }
        }
      }
    } catch (err) {
      console.error('[SessionManager] Failed to load state:', err);
    }
  }

  private saveState(): void {
    try {
      // Load existing state first to preserve sessions not in memory
      let state: PersistedState = { sessions: {} };
      if (fs.existsSync(this.stateFilePath)) {
        try {
          const data = fs.readFileSync(this.stateFilePath, 'utf-8');
          state = JSON.parse(data);
        } catch {
          // Ignore parse errors, start fresh
        }
      }

      // Merge current in-memory sessions (overwrites existing entries)
      for (const [id, session] of this.sessions) {
        if (session.audioSource) {
          state.sessions[id] = {
            id: session.id,
            createdAt: session.createdAt,
            audioSource: session.audioSource,
          };
        }
      }

      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2));
      console.log(`[SessionManager] State saved (${Object.keys(state.sessions).length} sessions)`);
    } catch (err) {
      console.error('[SessionManager] Failed to save state:', err);
    }
  }

  createSession(): Session {
    const id = nanoid(8);
    const session: Session = {
      id,
      createdAt: Date.now(),
      audioSource: null,
      playbackState: {
        isPlaying: false,
        currentTime: 0,
        lastSyncTimestamp: Date.now(),
      },
      clients: new Map(),
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreateSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession();
      // Replace the auto-generated ID with the requested one
      this.sessions.delete(session.id);
      session.id = sessionId;
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  addClient(sessionId: string, ws: WebSocket): ClientInfo {
    const session = this.getOrCreateSession(sessionId);
    const clientId = nanoid(6);
    const channel = this.assignChannel(session);

    const client: ClientInfo = {
      id: clientId,
      websocket: ws,
      assignedChannel: channel,
      latency: 0,
      isReady: false,
    };

    session.clients.set(clientId, client);
    return client;
  }

  removeClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clients.delete(clientId);
      // Only clean up sessions WITHOUT audio after a delay
      // Sessions with audio are kept forever (persisted)
      if (session.clients.size === 0 && !session.audioSource) {
        setTimeout(() => {
          const s = this.sessions.get(sessionId);
          if (s && s.clients.size === 0 && !s.audioSource) {
            this.sessions.delete(sessionId);
          }
        }, 60000); // Keep empty sessions for 1 minute
      }
    }
  }

  private assignChannel(session: Session): Channel {
    // Count existing channel assignments
    let leftCount = 0;
    let rightCount = 0;

    for (const client of session.clients.values()) {
      if (client.assignedChannel === 'left') leftCount++;
      if (client.assignedChannel === 'right') rightCount++;
    }

    // Assign to balance channels, prioritizing left then right
    if (leftCount === 0) return 'left';
    if (rightCount === 0) return 'right';
    // After first two clients, assign stereo (or could continue alternating)
    return leftCount <= rightCount ? 'left' : 'right';
  }

  setAudioSource(sessionId: string, audioSource: AudioSource): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.audioSource = audioSource;
      session.playbackState = {
        isPlaying: false,
        currentTime: 0,
        lastSyncTimestamp: Date.now(),
      };
      // Persist state when audio is loaded
      this.saveState();
    }
  }

  updatePlaybackState(
    sessionId: string,
    updates: Partial<PlaybackState>
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.playbackState = {
        ...session.playbackState,
        ...updates,
        lastSyncTimestamp: Date.now(),
      };
    }
  }

  setClientReady(sessionId: string, clientId: string, ready: boolean): void {
    const session = this.sessions.get(sessionId);
    const client = session?.clients.get(clientId);
    if (client) {
      client.isReady = ready;
    }
  }

  setClientLatency(sessionId: string, clientId: string, latency: number): void {
    const session = this.sessions.get(sessionId);
    const client = session?.clients.get(clientId);
    if (client) {
      client.latency = latency;
    }
  }

  areAllClientsReady(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.clients.size === 0) return false;
    for (const client of session.clients.values()) {
      if (!client.isReady) return false;
    }
    return true;
  }

  broadcastToSession(
    sessionId: string,
    message: object,
    excludeClientId?: string
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const data = JSON.stringify(message);
    for (const client of session.clients.values()) {
      if (client.id !== excludeClientId && client.websocket.readyState === 1) {
        client.websocket.send(data);
      }
    }
  }

  getClientList(sessionId: string): Array<{ id: string; channel: Channel; ready: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return Array.from(session.clients.values()).map((c) => ({
      id: c.id,
      channel: c.assignedChannel,
      ready: c.isReady,
    }));
  }
}
