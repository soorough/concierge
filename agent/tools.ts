import { safeFetch } from '../ingest/fetch.js';
import { getDb } from '../store/db.js';
import { currentFacts, type Fact } from '../store/ledger.js';
import { addToCart } from './cart.js';
import type { RetrievedProduct } from './retrieve.js';

/**
 * The live-truth operations, as callable tools.
 *
 * Ingest gives us a catalog snapshot, and a snapshot is right until the brand changes
 * something. The two places that actually hurt a customer are the price we quote and the
 * cart we write: both commit us to a number or an item, and both were being served from
 * whatever the catalog looked like at ingest.
 *
 * These functions are the callable surface for that. Nothing here is exposed to the model
 * yet — the turn is still one constrained model call — so this file closes the staleness
 * class without changing control flow. Letting the model choose to call them is a separate
 * change, and it wants a call budget before it is safe.
 *
 * The division of labour is deliberate: the cached catalog block answers "what goes with a
 * ribeye", which needs no live data and is why a turn is cheap. A live call happens only
 * when the agent is about to commit. Cached catalog for reasoning, live call for committing.
 */

export type ToolName =
  | 'resolve_price'
  | 'check_availability'
  | 'search_policy'
  | 'write_cart'
  | 'read_facts';

/** Where a number came from. `snapshot` means the live path was unavailable, not skipped. */
export type Provenance = 'live' | 'snapshot' | 'local';

export type ToolCall<T> = {
  tool: ToolName;
  ok: boolean;
  value: T;
  source: Provenance;
  /** Human-readable, and short enough to sit in a rail event's detail column. */
  detail: string;
  ms: number;
};

/*
 * A live lookup sits on the turn path, so it gets a tighter budget than ingest. 1.2s is
 * comfortably above a healthy storefront's response time and well inside the 2s p50 the
 * whole turn is held to. Past it we quote the snapshot and say so, because a slow answer
 * that is right is still a worse product than a fast answer that is honest about its age.
 */
const LIVE_TIMEOUT_MS = 1_200;

/*
 * Within a single conversation the same bottle gets asked about repeatedly. A short TTL
 * collapses that to one request without ever serving a price older than a minute, which is
 * a different order of staleness from one that is days old.
 */
const LIVE_TTL_MS = 60_000;

/**
 * An order of magnitude apart is not a price change.
 *
 * Any drift at all is worth logging — brands reprice, and the whole point of this file is
 * that we notice. But drift is only a *block* when the two numbers cannot both be plausible
 * prices for the same item, because then we do not know which one is real. That is the
 * currency defect generalised: ingesting a US brand from India returned INR, and $14.95
 * arrived as 1500.00. A hundredfold gap is a broken pipe. A twofold gap is a sale.
 */
const DRIFT_BLOCK_RATIO = 10;

export type LiveProduct = {
  priceCents: number;
  available: boolean;
  variantId: string | null;
};

type CacheEntry = { value: LiveProduct | null; expires: number };
const liveCache = new Map<string, CacheEntry>();

/** Exposed so the eval suite can run against a known cache state. */
export function clearLiveCache(): void {
  liveCache.clear();
}

type AjaxVariant = { id: number; price: number; available: boolean; sku: string | null };
type AjaxProduct = { price: number; available: boolean; variants: AjaxVariant[] };

/**
 * Shopify's AJAX product endpoint, which every storefront serves at `/products/{handle}.js`.
 *
 * Preferred over `/products/{handle}.json` for two reasons that only show up in use: the
 * `.json` form omits `available` entirely, so it cannot answer the stock half of the
 * question, and it returns prices as decimal strings where `.js` returns integer cents.
 * Parsing money out of a string is how rounding bugs get in.
 *
 * `safeFetch` carries the empty `Accept-Language` that pins a storefront to its own market,
 * so a live price arrives in the shop's currency rather than the caller's.
 */
async function fetchLive(domain: string, product: RetrievedProduct): Promise<LiveProduct | null> {
  const prefix = `https://${domain}/products/`;
  if (!product.url?.startsWith(prefix)) return null;

  const key = `${domain}|${product.url}`;
  const cached = liveCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value: LiveProduct | null = null;
  try {
    const { res, body } = await safeFetch(`${product.url}.js`, {
      timeoutMs: LIVE_TIMEOUT_MS,
      accept: 'application/json',
    });
    if (res.ok) {
      const payload = JSON.parse(body) as AjaxProduct;
      const variant =
        (payload.variants ?? []).find((v) => String(v.id) === product.variant_id) ?? null;
      value = {
        priceCents: variant ? Number(variant.price) : Number(payload.price),
        available: variant ? Boolean(variant.available) : Boolean(payload.available),
        variantId: variant ? String(variant.id) : product.variant_id,
      };
      if (!Number.isFinite(value.priceCents) || value.priceCents <= 0) value = null;
    }
  } catch {
    /* A live lookup that fails degrades to the snapshot, loudly. It never fails a turn. */
    value = null;
  }

  liveCache.set(key, { value, expires: Date.now() + LIVE_TTL_MS });
  return value;
}

/** Only Shopify brands have a live path. A crawled brand has a snapshot and nothing else. */
export const hasLivePath = (ingestPath: string): boolean => ingestPath === 'shopify';

export type PriceResolution = {
  priceCents: number;
  available: boolean;
  /** Snapshot minus live, in cents. Zero when they agree, absent when there is no live price. */
  driftCents: number | null;
  /** The two numbers are too far apart to both be prices for this item. */
  suspect: boolean;
};

/**
 * The price we are willing to say out loud.
 *
 * Returns the live number where the store will give one, the snapshot where it will not,
 * and always says which. The caller decides what to do about drift; this only measures it.
 */
export async function resolvePrice(opts: {
  domain: string;
  ingestPath: string;
  product: RetrievedProduct;
}): Promise<ToolCall<PriceResolution>> {
  const started = Date.now();
  const { domain, ingestPath, product } = opts;

  const snapshot: PriceResolution = {
    priceCents: product.price_cents,
    available: Boolean(product.available),
    driftCents: null,
    suspect: false,
  };

  if (!hasLivePath(ingestPath)) {
    return {
      tool: 'resolve_price',
      ok: true,
      value: snapshot,
      source: 'snapshot',
      detail: `${product.title}: no live path on a ${ingestPath} brand`,
      ms: Date.now() - started,
    };
  }

  const live = await fetchLive(domain, product);
  if (!live) {
    return {
      tool: 'resolve_price',
      ok: false,
      value: snapshot,
      source: 'snapshot',
      detail: `${product.title}: the store did not answer, quoting the snapshot`,
      ms: Date.now() - started,
    };
  }

  const driftCents = product.price_cents - live.priceCents;
  const ratio =
    Math.max(product.price_cents, live.priceCents) /
    Math.max(1, Math.min(product.price_cents, live.priceCents));

  return {
    tool: 'resolve_price',
    ok: true,
    value: {
      priceCents: live.priceCents,
      available: live.available,
      driftCents,
      suspect: ratio >= DRIFT_BLOCK_RATIO,
    },
    source: 'live',
    detail: driftCents === 0 ? `${product.title}: unchanged` : `${product.title}: moved`,
    ms: Date.now() - started,
  };
}

/**
 * Whether the store will actually sell this today.
 *
 * `product.available` is a fact about ingest day. A cart line written against a sold-out
 * variant produces a checkout the customer cannot complete, which is the worst place to
 * discover it.
 */
export async function checkAvailability(opts: {
  domain: string;
  ingestPath: string;
  product: RetrievedProduct;
}): Promise<ToolCall<{ available: boolean }>> {
  const started = Date.now();
  const { domain, ingestPath, product } = opts;

  if (!hasLivePath(ingestPath)) {
    return {
      tool: 'check_availability',
      ok: true,
      value: { available: Boolean(product.available) },
      source: 'snapshot',
      detail: `${product.title}: no live path on a ${ingestPath} brand`,
      ms: Date.now() - started,
    };
  }

  const live = await fetchLive(domain, product);
  if (!live) {
    return {
      tool: 'check_availability',
      ok: false,
      value: { available: Boolean(product.available) },
      source: 'snapshot',
      detail: `${product.title}: the store did not answer`,
      ms: Date.now() - started,
    };
  }

  return {
    tool: 'check_availability',
    ok: true,
    value: { available: live.available },
    source: 'live',
    detail: `${product.title}: ${live.available ? 'in stock' : 'out of stock'}`,
    ms: Date.now() - started,
  };
}

export type PolicyHit = { kind: string; text: string; source_url: string };

/**
 * Policy search stays local on purpose.
 *
 * The brand's own pages are ingested in full and carried on every turn, so there is no
 * staleness to close here — a shipping policy is not repriced hourly. Making it a tool is
 * about giving the loop a uniform surface to call, not about the transport.
 */
export function searchPolicy(opts: {
  brandId: string;
  query: string;
  limit?: number;
}): ToolCall<PolicyHit[]> {
  const started = Date.now();
  const terms = opts.query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);

  if (!terms.length) {
    return {
      tool: 'search_policy',
      ok: true,
      value: [],
      source: 'local',
      detail: 'no searchable terms',
      ms: Date.now() - started,
    };
  }

  const match = terms.map((t) => `"${t}"`).join(' OR ');
  const rows = getDb()
    .prepare(
      `select pc.kind, pc.text, pc.source_url
       from policy_fts f join policy_chunk pc on pc.rowid = f.rowid
       where policy_fts match ? and pc.brand_id = ?
       order by rank limit ?`,
    )
    .all(match, opts.brandId, opts.limit ?? 3) as PolicyHit[];

  return {
    tool: 'search_policy',
    ok: true,
    value: rows,
    source: 'local',
    detail: `${rows.length} chunk(s) for "${opts.query.slice(0, 40)}"`,
    ms: Date.now() - started,
  };
}

/**
 * Write a cart line, having first asked the store whether it can be sold.
 *
 * The availability check is the write-time half of the staleness fix. It runs before the
 * insert, so a sold-out item never reaches a cart rather than being removed from one.
 */
export async function writeCart(opts: {
  domain: string;
  ingestPath: string;
  customerId: string;
  product: RetrievedProduct;
  qty: number;
}): Promise<ToolCall<{ written: boolean; available: boolean }>> {
  const started = Date.now();
  const stock = await checkAvailability(opts);

  if (!stock.value.available) {
    return {
      tool: 'write_cart',
      ok: false,
      value: { written: false, available: false },
      source: stock.source,
      detail: `${opts.product.title} is out of stock at the store`,
      ms: Date.now() - started,
    };
  }

  addToCart(opts.customerId, opts.product.id, opts.qty);
  return {
    tool: 'write_cart',
    ok: true,
    value: { written: true, available: true },
    source: stock.source,
    detail: `${opts.product.title} x${opts.qty}`,
    ms: Date.now() - started,
  };
}

/** Everything currently true about this customer, newest provenance first. */
export function readFacts(customerId: string): ToolCall<Fact[]> {
  const started = Date.now();
  const facts = currentFacts(customerId);
  return {
    tool: 'read_facts',
    ok: true,
    value: facts,
    source: 'local',
    detail: `${facts.length} current fact(s)`,
    ms: Date.now() - started,
  };
}
