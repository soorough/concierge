import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { migrate, getDb } from '../store/db.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerThreadRoutes } from './routes/thread.js';
import { registerGate } from './gate.js';

const here = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

migrate(getDb());

await registerGate(app);
await registerIngestRoutes(app);
await registerThreadRoutes(app);

app.get('/api/health', async () => ({ ok: true, at: Date.now() }));

// Single origin: the API and the built console are served by the same process, so there
// is no CORS surface and SSE has no cross-origin quirks.
const consoleDist = join(here, '..', '..', 'console', 'dist');
if (existsSync(consoleDist)) {
  await app.register(fastifyStatic, { root: consoleDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`console build not found at ${consoleDist} — run: npm --prefix console run build`);
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
