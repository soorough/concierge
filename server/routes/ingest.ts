import type { FastifyInstance } from 'fastify';
import { preflight, ingestDomain } from '../../ingest/index.js';
import { normaliseDomain } from '../../ingest/fetch.js';
import { getBrandByDomain } from '../../store/queries.js';
import { getDb } from '../../store/db.js';
import { checkIngestAllowed } from '../../agent/limits.js';
import { getMetrics, checkSlos } from '../../store/metrics.js';

export async function registerIngestRoutes(app: FastifyInstance) {
  app.post<{ Body: { domain: string } }>('/api/preflight', async (req, reply) => {
    try {
      return await preflight(req.body.domain);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** SSE so the console shows real committed progress rather than an animated bar. */
  app.post<{ Body: { domain: string; force?: boolean } }>('/api/ingest', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

    const limit = checkIngestAllowed(String(req.ip));
    if (!limit.allowed) {
      send({ type: 'error', message: limit.message });
      reply.raw.end();
      return;
    }

    try {
      const result = await ingestDomain(req.body.domain, send, { force: req.body.force });
      send({ type: 'result', result });
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
    }
    reply.raw.end();
  });

  app.get<{ Params: { domain: string } }>('/api/brand/:domain', async (req, reply) => {
    const brand = getBrandByDomain(normaliseDomain(req.params.domain));
    if (!brand) return reply.code(404).send({ error: 'not ingested' });
    const db = getDb();
    const counts = db
      .prepare(`select
                  sum(sellable) sellable,
                  count(*) total,
                  (select count(*) from policy_chunk where brand_id = ?) policies
                from product where brand_id = ?`)
      .get(brand.id, brand.id) as { sellable: number; total: number; policies: number };
    return {
      ...brand,
      palette: JSON.parse(brand.palette_json ?? '[]'),
      restrictedRegions: JSON.parse(brand.restricted_regions_json ?? '[]'),
      missing: JSON.parse(brand.missing_json ?? '[]'),
      counts,
    };
  });

  /** Live health, for the console and for anything watching from outside. */
  app.get<{ Querystring: { hours?: string } }>('/api/metrics', async (req) => {
    const hours = Math.min(720, Math.max(1, Number(req.query?.hours ?? 24)));
    const metrics = getMetrics(hours);
    return { ...metrics, slos: checkSlos(metrics) };
  });

  app.get('/api/brands', async () =>
    getDb().prepare('select id, domain, name, category, detected_sms_vendor, ingested_at from brand order by ingested_at desc').all(),
  );
}
