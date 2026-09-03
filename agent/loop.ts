import { getDb } from '../store/db.js';
import { getOrCreateCustomer, recordTurn, recordRailEvent, type Customer } from '../store/session.js';
import { writeFact } from '../store/ledger.js';
import { retrieve } from './retrieve.js';
import { buildSystemPrompt } from './prompt.js';
import { runPreRails } from './rails/pre.js';
import { runPostRails, parseModelOutput } from './rails/post.js';
import { getProvider } from './providers/index.js';
import { addToCart, getCart, type CartView } from './cart.js';
import type { StoredBrand } from '../store/queries.js';
import type { RailEvent } from './rails/types.js';

export type TurnResult = {
  turnId: string;
  customerId: string;
  reply: string | null;
  cart: CartView | null;
  showCheckout: boolean;
  needsAgeCheck: boolean;
  rails: RailEvent[];
  latencyMs: number;
  costCents: number;
  model: string | null;
  provider: string | null;
};

/**
 * One turn: rails, retrieval, one model call, rails, side effects. Ingest never runs
 * here. There is no second model call on the turn path — fact extraction rides along in
 * the same response rather than costing another round trip.
 */
export async function runTurn(opts: {
  brand: StoredBrand;
  sessionId: string;
  text: string;
}): Promise<TurnResult> {
  const started = Date.now();
  const db = getDb();
  const { brand, sessionId, text } = opts;

  let customer: Customer = getOrCreateCustomer(brand.id, sessionId);
  const inTurnId = recordTurn({ customerId: customer.id, direction: 'in', text });

  // --- pre-model rails: these never reach the model
  const pre = runPreRails(customer, text);
  if (pre.halt) {
    for (const e of pre.events) recordRailEvent(inTurnId, e.level, e.code, e.detail);
    const outId = pre.reply
      ? recordTurn({
          customerId: customer.id, direction: 'out', text: pre.reply,
          latencyMs: Date.now() - started, costCents: 0,
        })
      : inTurnId;
    return {
      turnId: outId, customerId: customer.id, reply: pre.reply, cart: null,
      showCheckout: false, needsAgeCheck: false, rails: pre.events,
      latencyMs: Date.now() - started, costCents: 0, model: null, provider: null,
    };
  }

  // --- retrieval
  const retrieval = retrieve({ brandId: brand.id, customerId: customer.id, message: text });

  const sellableRows = db
    .prepare('select id, sku from product where brand_id = ? and sellable = 1')
    .all(brand.id) as { id: string; sku: string | null }[];
  const nonSellableRows = db
    .prepare('select id, sku from product where brand_id = ? and sellable = 0')
    .all(brand.id) as { id: string; sku: string | null }[];
  const keyOf = (r: { id: string; sku: string | null }) => (r.sku || r.id).toLowerCase();
  const allSellableSkus = new Set(sellableRows.map(keyOf));
  const nonSellableSkus = new Set(nonSellableRows.map(keyOf));

  const offers = JSON.parse(brand.offers_json ?? '[]') as string[];
  const restrictedRegions = JSON.parse(brand.restricted_regions_json ?? '[]') as string[];

  const system = buildSystemPrompt({
    brand,
    retrieval,
    offers,
    restrictedRegions,
    ageVerified: Boolean(customer.age_verified_at),
  });

  const history = retrieval.history
    .filter((t) => t.text)
    .map((t) => ({ role: (t.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant', content: t.text! }));

  // --- model call
  const provider = getProvider();
  const res = await provider.call({
    system,
    messages: [...history.slice(-8), { role: 'user', content: text }],
  });

  let parsed;
  try {
    parsed = parseModelOutput(res.text);
  } catch (e) {
    const outId = recordTurn({
      customerId: customer.id, direction: 'out',
      text: "Sorry — something went wrong on my end. Let me get someone from the team.",
      model: res.model, provider: res.provider, costCents: res.costCents,
      latencyMs: Date.now() - started,
    });
    recordRailEvent(outId, 'block', 'MALFORMED_OUTPUT', (e as Error).message.slice(0, 200));
    return {
      turnId: outId, customerId: customer.id,
      reply: "Sorry — something went wrong on my end. Let me get someone from the team.",
      cart: null, showCheckout: false, needsAgeCheck: false,
      rails: [{ level: 'block', code: 'MALFORMED_OUTPUT' }],
      latencyMs: Date.now() - started, costCents: res.costCents,
      model: res.model, provider: res.provider,
    };
  }

  // --- post-model rails
  const post = runPostRails(parsed, {
    catalog: retrieval.products,
    allSellableSkus,
    nonSellableSkus,
    category: brand.category,
    ageVerified: Boolean(customer.age_verified_at),
    restrictedRegions,
    customerRegion: customer.region,
  });

  // --- side effects
  const bySku = new Map(retrieval.products.map((p) => [(p.sku || p.id).toLowerCase(), p]));
  for (const a of post.actions) {
    if (a.type === 'add_to_cart' && a.sku) {
      const product = bySku.get(a.sku.toLowerCase());
      if (product) addToCart(customer.id, product.id, a.qty ?? 1);
    }
  }

  for (const f of parsed.learned ?? []) {
    if (!f?.predicate || !f?.object) continue;
    const r = writeFact({
      customerId: customer.id,
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence ?? 0.6,
      source: 'conversation',
      sourceTurnId: inTurnId,
    });
    post.events.push({
      level: 'pass',
      code: r.action === 'superseded' ? 'FACT_SUPERSEDED' : 'FACT_LEARNED',
      detail: `${f.predicate}=${f.object}${r.action === 'ignored' ? ` (${r.reason})` : ''}`,
    });
  }

  const showCheckout =
    post.actions.some((a) => a.type === 'show_checkout') && !post.blockCheckout && !post.escalated;
  const cart = getCart(customer.id, brand.domain, brand.ingest_path);

  const outTurnId = recordTurn({
    customerId: customer.id, direction: 'out', text: post.reply,
    payload: showCheckout ? { card: 'checkout' } : null,
    model: res.model, provider: res.provider,
    inputTokens: res.inputTokens, outputTokens: res.outputTokens,
    costCents: res.costCents, latencyMs: Date.now() - started,
  });
  for (const e of post.events) recordRailEvent(outTurnId, e.level, e.code, e.detail);

  return {
    turnId: outTurnId, customerId: customer.id, reply: post.reply,
    cart: cart.lines.length ? cart : null,
    showCheckout, needsAgeCheck: post.needsAgeCheck, rails: post.events,
    latencyMs: Date.now() - started, costCents: res.costCents,
    model: res.model, provider: res.provider,
  };
}
