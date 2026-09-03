import type { FastifyInstance } from 'fastify';
import { getDb } from '../../store/db.js';
import { getOrCreateCustomer, recordTurn, recentTurns, railEventsFor } from '../../store/session.js';

/**
 * The thread surface. Every message round-trips through SQLite — nothing is held in
 * memory on the client, so a reload replays the real conversation.
 *
 * The agent loop is not wired in yet: this stage exists to prove the surface, the
 * session scoping, and persistence before any model call is involved.
 */
export async function registerThreadRoutes(app: FastifyInstance) {
  app.post<{ Body: { brandId: string; sessionId: string; text: string } }>(
    '/api/turn',
    async (req, reply) => {
      const { brandId, sessionId, text } = req.body ?? {};
      if (!brandId || !sessionId || typeof text !== 'string') {
        return reply.code(400).send({ error: 'brandId, sessionId and text are required' });
      }
      const brand = getDb().prepare('select * from brand where id = ?').get(brandId) as
        | { id: string; name: string }
        | undefined;
      if (!brand) return reply.code(404).send({ error: 'brand not ingested' });

      const started = Date.now();
      const customer = getOrCreateCustomer(brandId, sessionId);

      recordTurn({ customerId: customer.id, direction: 'in', text });

      // Placeholder until the agent loop lands. Deliberately not a canned "reply" —
      // it echoes what was stored so the round-trip is visibly real.
      const stored = recentTurns(customer.id, 1)[0];
      const replyText = `stored "${stored?.text ?? ''}" as ${stored?.id} — agent loop not wired yet`;

      const outId = recordTurn({
        customerId: customer.id,
        direction: 'out',
        text: replyText,
        latencyMs: Date.now() - started,
      });

      return { turnId: outId, customerId: customer.id, reply: replyText, latencyMs: Date.now() - started };
    },
  );

  app.get<{ Querystring: { brandId: string; sessionId: string } }>(
    '/api/thread',
    async (req, reply) => {
      const { brandId, sessionId } = req.query ?? {};
      if (!brandId || !sessionId) {
        return reply.code(400).send({ error: 'brandId and sessionId are required' });
      }
      const customer = getOrCreateCustomer(brandId, sessionId);
      const turns = recentTurns(customer.id, 100);
      const rails = railEventsFor(turns.map((t) => t.id));
      return {
        customer,
        turns: turns.map((t) => ({
          ...t,
          payload: t.payload_json ? JSON.parse(t.payload_json) : null,
          rails: rails.filter((r) => r.turn_id === t.id),
        })),
      };
    },
  );
}
