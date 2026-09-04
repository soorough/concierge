import { getDb } from '../store/db.js';
import { getOrCreateCustomer, recordTurn, recordRailEvent, type Customer } from '../store/session.js';
import { writeFact } from '../store/ledger.js';
import { retrieve, type RetrievedProduct } from './retrieve.js';
import { buildSystemBlocks } from './prompt.js';
import { runPreRails } from './rails/pre.js';
import { runPostRails, parseModelOutput, type ModelAction } from './rails/post.js';
import { getProvider } from './providers/index.js';
import { addToCart, getCartPriced, type CartView } from './cart.js';
import { checkTurnAllowed, recordSpend } from './limits.js';
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

/** The same addressing the rails use: catalog number, SKU, or id. */
function buildIndex(products: RetrievedProduct[]): Map<string, RetrievedProduct> {
  const index = new Map<string, RetrievedProduct>();
  products.forEach((p, i) => {
    index.set(String(i + 1), p);
    if (p.sku) index.set(p.sku.toLowerCase(), p);
    index.set(p.id.toLowerCase(), p);
  });
  return index;
}

const actionKey = (a: ModelAction): string =>
  a.ref !== undefined ? String(a.ref) : (a.sku ?? '').toLowerCase();

function nonSellableSkus(brandId: string): Set<string> {
  const rows = getDb()
    .prepare('select id, sku from product where brand_id = ? and sellable = 0')
    .all(brandId) as { id: string; sku: string | null }[];
  return new Set(rows.map((r) => (r.sku ?? r.id).toLowerCase()));
}

/**
 * One turn: rails, retrieval, one model call, rails, side effects.
 *
 * Ingest never runs here, and there is no second model call on the turn path — fact
 * extraction rides along in the same response rather than costing another round trip.
 */
export async function runTurn(opts: {
  brand: StoredBrand;
  sessionId: string;
  text: string;
}): Promise<TurnResult> {
  const started = Date.now();
  const { brand, sessionId, text } = opts;
  const customer: Customer = getOrCreateCustomer(brand.id, sessionId);

  const inboundTurnId = recordTurn({ customerId: customer.id, direction: 'in', text });

  // --- pre-model rails: these never reach the model
  const pre = runPreRails(customer, text);
  if (pre.halt) {
    for (const event of pre.events) {
      recordRailEvent(inboundTurnId, event.level, event.code, event.detail);
    }
    const turnId = pre.reply
      ? recordTurn({
          customerId: customer.id,
          direction: 'out',
          text: pre.reply,
          latencyMs: Date.now() - started,
          costCents: 0,
        })
      : inboundTurnId;

    return {
      turnId,
      customerId: customer.id,
      reply: pre.reply,
      cart: null,
      showCheckout: false,
      needsAgeCheck: false,
      rails: pre.events,
      latencyMs: Date.now() - started,
      costCents: 0,
      model: null,
      provider: null,
    };
  }

  // --- tool limits: refused before any model call, and visible as a rail
  const limit = checkTurnAllowed(customer.id, text);
  if (!limit.allowed) {
    const turnId = recordTurn({
      customerId: customer.id,
      direction: 'out',
      text: limit.message,
      latencyMs: Date.now() - started,
      costCents: 0,
    });
    recordRailEvent(turnId, 'block', limit.code, 'refused before any model call');

    return {
      turnId,
      customerId: customer.id,
      reply: limit.message,
      cart: null,
      showCheckout: false,
      needsAgeCheck: false,
      rails: [{ level: 'block', code: limit.code, detail: 'refused before any model call' }],
      latencyMs: Date.now() - started,
      costCents: 0,
      model: null,
      provider: null,
    };
  }

  // --- retrieval
  const retrieval = retrieve({ brandId: brand.id, customerId: customer.id, message: text });

  const offers = JSON.parse(brand.offers_json ?? '[]') as string[];

  const system = buildSystemBlocks({
    brand,
    retrieval,
    offers,
    restrictedRegions: JSON.parse(brand.restricted_regions_json ?? '[]') as string[],
    ageVerified: Boolean(customer.age_verified_at),
  });

  const history = retrieval.history
    .filter((t) => t.text)
    .slice(-8)
    .map((t) => ({
      role: (t.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: t.text!,
    }));

  // --- model call
  const provider = getProvider();
  const response = await provider.call({
    // The catalog block is identical across a brand's turns, so it is cached; everything
    // that changes per turn follows it.
    system: [
      { text: system.stable, cache: true },
      { text: system.volatile },
    ],
    messages: [...history, { role: 'user', content: text }],
    prefill: '{',
  });

  /*
   * A model that returns something other than JSON should degrade, not fail. The text is
   * used as the reply and the rails still run over it, so a recovered turn is held to the
   * same standard as a parsed one.
   */
  recordSpend(response.costCents);

  const parsed = parseModelOutput(response.text);
  const recoveryEvent: RailEvent | null = parsed.recovered
    ? { level: 'warn', code: 'OUTPUT_RECOVERED', detail: parsed.recovered }
    : null;

  // --- post-model rails
  const post = runPostRails(parsed, {
    catalog: retrieval.products,
    nonSellableSkus: nonSellableSkus(brand.id),
    category: brand.category,
    ageVerified: Boolean(customer.age_verified_at),
    restrictedRegions: JSON.parse(brand.restricted_regions_json ?? '[]') as string[],
    customerRegion: customer.region,
    priceOrdered: retrieval.priceOrdered,
    currency: brand.currency ?? 'USD',
    authorisedOffers: offers,
    policyText: [
      ...retrieval.groundTruth.map((d) => d.text),
      ...retrieval.policies.map((p) => p.text),
    ].join('\n'),
  });

  if (recoveryEvent) post.events.unshift(recoveryEvent);

  // --- side effects
  const index = buildIndex(retrieval.products);
  for (const action of post.actions) {
    if (action.type !== 'add_to_cart') continue;
    const product = index.get(actionKey(action));
    if (product) addToCart(customer.id, product.id, action.qty ?? 1);
  }

  for (const fact of parsed.learned ?? []) {
    if (!fact?.predicate || !fact?.object) continue;
    const result = writeFact({
      customerId: customer.id,
      predicate: fact.predicate,
      object: fact.object,
      confidence: fact.confidence ?? 0.6,
      source: 'conversation',
      sourceTurnId: inboundTurnId,
    });
    post.events.push({
      level: 'pass',
      code: result.action === 'superseded' ? 'FACT_SUPERSEDED' : 'FACT_LEARNED',
      detail: `${fact.predicate}=${fact.object}${result.action === 'ignored' ? ` (${result.reason})` : ''}`,
    });
  }

  const cart = await getCartPriced(
    customer.id,
    brand.domain,
    brand.ingest_path,
    JSON.parse(brand.mcp_tools_json ?? '[]') as string[],
  );

  /*
   * The card follows cart state rather than the model choosing to emit show_checkout.
   * Leaving it to the model produced a real cart holding a real item with no way for the
   * customer to see or act on it: the agent said "adding it to your cart" and the thread
   * simply stopped.
   */
  const showCheckout = cart.lines.length > 0 && !post.blockCheckout && !post.escalated;

  const outboundTurnId = recordTurn({
    customerId: customer.id,
    direction: 'out',
    text: post.reply,
    payload: showCheckout ? { card: 'checkout' } : null,
    model: response.model,
    provider: response.provider,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costCents: response.costCents,
    latencyMs: Date.now() - started,
  });
  for (const event of post.events) {
    recordRailEvent(outboundTurnId, event.level, event.code, event.detail);
  }

  return {
    turnId: outboundTurnId,
    customerId: customer.id,
    reply: post.reply,
    cart: cart.lines.length ? cart : null,
    showCheckout,
    needsAgeCheck: post.needsAgeCheck,
    rails: post.events,
    latencyMs: Date.now() - started,
    costCents: response.costCents,
    model: response.model,
    provider: response.provider,
  };
}
