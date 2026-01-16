import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { SessionManager } from './services/SessionManager.js';
import { AudioProcessor } from './services/AudioProcessor.js';
import { setupWebSocket } from './websocket/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

async function main() {
  const app = Fastify({ logger: true });

  // Initialize services
  const audioDir = path.join(__dirname, '../audio');
  const sessionManager = new SessionManager(audioDir);
  const audioProcessor = new AudioProcessor(audioDir);

  // Register plugins
  await app.register(fastifyWebsocket);

  // Serve static files from public/
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/',
  });

  // Serve audio files
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '../audio'),
    prefix: '/audio/',
    decorateReply: false,
  });

  // API routes
  app.get('/api/session/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return {
      id: session.id,
      hasAudio: !!session.audioSource,
      clientCount: session.clients.size,
      playbackState: session.playbackState,
    };
  });

  // WebSocket handler
  setupWebSocket(app, sessionManager, audioProcessor);

  // Start server
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`\n🎵 Stereo Server running at http://localhost:${PORT}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
