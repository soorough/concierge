import type { FastifyInstance } from 'fastify';
import { getDb } from '../../store/db.js';
import { getOrCreateCustomer, recentTurns, railEventsFor } from '../../store/session.js';
import { runTurn } from '../../agent/loop.js';
import { getCartPriced, setQty, clearCart } from '../../agent/cart.js';
import { currentFacts, allFacts, writeFact } from '../../store/ledger.js';
import type { StoredBrand } from '../../store/queries.js';

/**
 * The thread surface. Every message round-trips through SQLite — nothing is held in
 * memory on the client, so a reload replays the real conversation.
 *
 * Threads are scoped to (brand, session) so simultaneous visitors never share a
 * customer row, a cart, or a fact ledger.
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
        | StoredBrand
        | undefined;
      if (!brand) return reply.code(404).send({ error: 'brand not ingested' });

      try {
        const result = await runTurn({ brand: brand as StoredBrand, sessionId, text });
        return result;
      } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: (e as Error).message });
      }
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

  /** Cart mutations are server-side: the subtotal always recomputes from DB prices. */
  app.post<{ Body: { brandId: string; sessionId: string; productId: string; qty: number } }>(
    '/api/cart/qty',
    async (req, reply) => {
      const { brandId, sessionId, productId, qty } = req.body ?? {};
      const brand = getDb().prepare('select * from brand where id = ?').get(brandId) as StoredBrand | undefined;
      if (!brand) return reply.code(404).send({ error: 'brand not ingested' });
      const customer = getOrCreateCustomer(brandId, sessionId);
      setQty(customer.id, productId, qty);
      return getCartPriced(customer.id, brand.domain, brand.ingest_path, JSON.parse(brand.mcp_tools_json ?? '[]'));
    },
  );

  app.post<{ Body: { brandId: string; sessionId: string } }>('/api/cart/clear', async (req, reply) => {
    const { brandId, sessionId } = req.body ?? {};
    const brand = getDb().prepare('select * from brand where id = ?').get(brandId) as StoredBrand | undefined;
    if (!brand) return reply.code(404).send({ error: 'brand not ingested' });
    const customer = getOrCreateCustomer(brandId, sessionId);
    clearCart(customer.id);
    return getCartPriced(customer.id, brand.domain, brand.ingest_path, JSON.parse(brand.mcp_tools_json ?? '[]'));
  });

  /** The age gate is a real state change, not a UI flag. */
  app.post<{ Body: { brandId: string; sessionId: string; confirmed: boolean } }>(
    '/api/age',
    async (req, reply) => {
      const { brandId, sessionId, confirmed } = req.body ?? {};
      const customer = getOrCreateCustomer(brandId, sessionId);
      if (confirmed) {
        getDb().prepare('update customer set age_verified_at = ? where id = ?').run(Date.now(), customer.id);
      }
      return { ageVerified: confirmed };
    },
  );

  /**
   * Second ingest source. A rep's note about a customer is third-party: it lands in the
   * same ledger and is outranked by anything the customer says themselves.
   */
  app.post<{ Body: { brandId: string; sessionId: string; note: string } }>(
    '/api/fieldnote',
    async (req, reply) => {
      const { brandId, sessionId, note } = req.body ?? {};
      if (!note?.trim()) return reply.code(400).send({ error: 'note is required' });
      const customer = getOrCreateCustomer(brandId, sessionId);
      const { extractFieldNoteFacts } = await import('../../agent/fieldnote.js');
      const extracted = await extractFieldNoteFacts(note);
      const results = extracted.map((f) =>
        writeFact({
          customerId: customer.id,
          predicate: f.predicate,
          object: f.object,
          confidence: f.confidence,
          source: 'field_note',
        }),
      );
      return { extracted, results, facts: currentFacts(customer.id) };
    },
  );

  app.get<{ Querystring: { brandId: string; sessionId: string } }>('/api/facts', async (req, reply) => {
    const { brandId, sessionId } = req.query ?? {};
    if (!brandId || !sessionId) return reply.code(400).send({ error: 'brandId and sessionId are required' });
    const customer = getOrCreateCustomer(brandId, sessionId);
    return { current: currentFacts(customer.id), all: allFacts(customer.id) };
  });

  app.get<{ Querystring: { brandId: string; sessionId: string } }>('/api/cart', async (req, reply) => {
    const { brandId, sessionId } = req.query ?? {};
    const brand = getDb().prepare('select * from brand where id = ?').get(brandId) as StoredBrand | undefined;
    if (!brand) return reply.code(404).send({ error: 'brand not ingested' });
    const customer = getOrCreateCustomer(brandId, sessionId);
    return getCartPriced(customer.id, brand.domain, brand.ingest_path, JSON.parse(brand.mcp_tools_json ?? '[]'));
  });
}
