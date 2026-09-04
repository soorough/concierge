import { loadEnv } from './env.js';

loadEnv();

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { migrate, getDb, dbPath, storageIsPersistent } from '../store/db.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerThreadRoutes } from './routes/thread.js';
import { registerGate } from './gate.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

migrate(getDb());

if (!storageIsPersistent()) {
  app.log.warn(
    `database at ${dbPath()} is inside the working directory — it will be erased on the next deploy. ` +
      'Set DB_PATH to a mounted volume, e.g. /data/concierge.db',
  );
}

await registerGate(app);
await registerIngestRoutes(app);
await registerThreadRoutes(app);

app.get('/api/health', async () => ({
  ok: true,
  at: Date.now(),
  storage: {
    path: dbPath(),
    persistent: storageIsPersistent(),
    ...(storageIsPersistent()
      ? {}
      : {
          warning:
            'DB_PATH is inside the working directory, so the database is erased on every deploy. Point it at a mounted volume, e.g. /data/concierge.db',
        }),
  },
}));

// Single origin: the API and the built console are served by the same process, so there
// is no CORS surface and SSE has no cross-origin quirks.
// Resolved from the project root so it is correct both under tsx (server/) and from a
// build (dist/server/).
const consoleDist = join(process.cwd(), 'console', 'dist');
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
