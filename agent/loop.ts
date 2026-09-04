import { getDb } from '../store/db.js';
import { getOrCreateCustomer, recordTurn, recordRailEvent, type Customer } from '../store/session.js';
import { writeFact } from '../store/ledger.js';
import { retrieve, type RetrievedProduct } from './retrieve.js';
import { buildSystemBlocks } from './prompt.js';
import { runPreRails } from './rails/pre.js';
import {
  runPostRails,
  parseModelOutput,
  ESCALATION_REPLY,
  type ModelAction,
  type LivePriceEntry,
} from './rails/post.js';
import { resolvePrice, checkAvailability, writeCart, hasLivePath } from './tools.js';
import { getProvider } from './providers/index.js';
import { getCartPriced, type CartView } from './cart.js';
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


/*
 * How many products to warm before the model has chosen any.
 *
 * The model takes roughly a second to answer and the store answers in about half of one, so
 * the live lookup is free if it is started early enough. Retrieval already knows which
 * products are lexically closest to the question, and a reply that quotes a price almost
 * always quotes one of those.
 *
 * Kept small on purpose: this is somebody else's storefront, and warming their whole catalog
 * on every turn to save 500ms on some of them is not a trade we are entitled to make.
 */
const PREFETCH_LIMIT = 4;

/**
 * Warm the live cache while the model is still thinking.
 *
 * Deliberately not awaited. A prefetch that fails, times out, or finishes after the model
 * costs the turn nothing — the real lookup simply pays its own round trip, exactly as it
 * would have. Nothing downstream reads this promise.
 */
function prefetchLive(brand: StoredBrand, retrieval: { products: RetrievedProduct[]; detailed: Set<string>; cartProducts: RetrievedProduct[] }): void {
  if (!hasLivePath(brand.ingest_path)) return;

  const closest = retrieval.products.filter((p) => retrieval.detailed.has(p.id)).slice(0, PREFETCH_LIMIT);
  const warm = [...retrieval.cartProducts, ...closest].slice(0, PREFETCH_LIMIT + retrieval.cartProducts.length);

  for (const product of warm) {
    void checkAvailability({ domain: brand.domain, ingestPath: brand.ingest_path, product }).catch(
      () => undefined,
    );
  }
}

/** Every distinct product the model asked us to price in this reply. */
const PRICE_TOKEN = /\{\{price:([^}]+)\}\}/g;

/**
 * Ask the store what these cost, before the rails decide what may be said.
 *
 * This runs between the model call and the rails rather than inside them, which keeps
 * `runPostRails` synchronous and pure — the property the deterministic suite depends on,
 * since it runs the rails with no network and no API key. The rails receive facts about the
 * live store; they do not go and get them.
 *
 * Lookups are issued together, so a reply quoting three wines costs one round trip's
 * latency, not three.
 */
async function resolveLivePrices(
  brand: StoredBrand,
  reply: string,
  catalog: RetrievedProduct[],
): Promise<{ prices: Map<string, LivePriceEntry>; ms: number }> {
  const prices = new Map<string, LivePriceEntry>();
  if (!reply) return { prices, ms: 0 };

  const index = buildIndex(catalog);
  const wanted = new Map<string, RetrievedProduct>();
  for (const [, ref] of reply.matchAll(PRICE_TOKEN)) {
    const product = index.get(ref.trim().toLowerCase());
    if (product) wanted.set(product.id, product);
  }
  if (!wanted.size) return { prices, ms: 0 };

  const started = Date.now();
  const results = await Promise.all(
    [...wanted.values()].map((product) =>
      resolvePrice({ domain: brand.domain, ingestPath: brand.ingest_path, product }),
    ),
  );

  results.forEach((result, i) => {
    const product = [...wanted.values()][i];
    prices.set(product.id, {
      priceCents: result.value.priceCents,
      source: result.source === 'live' ? 'live' : 'snapshot',
      driftCents: result.value.driftCents,
      suspect: result.value.suspect,
      stale: result.source !== 'live' && hasLivePath(brand.ingest_path),
    });
  });

  return { prices, ms: Date.now() - started };
}

/**
 * One turn: rails, retrieval, one model call, live lookups, rails, side effects.
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

  /*
   * The live lookups start here rather than after the model answers, so their latency hides
   * inside the model call instead of being added to it. A turn that quotes a price then
   * costs what it did before rather than half a second more.
   */
  prefetchLive(brand, retrieval);

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

  /*
   * --- live truth, before the rails judge the reply
   *
   * Only for products the model actually asked us to price. A turn that recommends without
   * quoting — most turns — makes no network call and costs exactly what it did before.
   */
  const live = await resolveLivePrices(brand, parsed.reply ?? '', retrieval.products);

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
    livePrices: live.prices,
    liveLookupMs: live.ms || undefined,
  });

  if (recoveryEvent) post.events.unshift(recoveryEvent);

  /*
   * --- side effects
   *
   * A cart write asks the store whether the item can still be sold, and does not write when
   * the answer is no. Ingest-day availability produces a checkout the customer cannot
   * complete, which is the worst possible place to find out.
   *
   * A refusal here contradicts a reply that already said the item was added, so the turn
   * escalates rather than shipping a sentence the cart disagrees with. That is the same
   * rule `CART_MISMATCH` enforces, applied to the store's answer instead of the model's.
   */
  const index = buildIndex(retrieval.products);
  let stockRefused = false;
  for (const action of post.actions) {
    if (action.type !== 'add_to_cart') continue;
    const product = index.get(actionKey(action));
    if (!product) continue;

    const write = await writeCart({
      domain: brand.domain,
      ingestPath: brand.ingest_path,
      customerId: customer.id,
      product,
      qty: action.qty ?? 1,
    });

    if (write.value.written) {
      if (write.source === 'live') {
        post.events.push({ level: 'pass', code: 'STOCK_LIVE', detail: write.detail });
      }
    } else {
      stockRefused = true;
      post.events.push({ level: 'block', code: 'STOCK_DRIFT', detail: write.detail });
    }
  }

  if (stockRefused) {
    post.reply = ESCALATION_REPLY;
    post.escalated = true;
    post.blockCheckout = true;
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
