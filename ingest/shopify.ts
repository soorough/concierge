import { safeFetch } from './fetch.js';
import { stripHtml } from './text.js';
import { fetchBrandMeta, classifyCategory } from './brandmeta.js';
import { discoverMcpTools } from './mcp.js';
import type { ContextPack, PackPolicy, PackProduct, OnProgress } from './types.js';

type ShopifyVariant = { id: number; sku: string | null; price: string; available: boolean; title: string };
type ShopifyProduct = {
  id: number; title: string; handle: string; body_html: string | null;
  product_type: string | null; tags: string[]; variants: ShopifyVariant[];
  images: { src: string }[];
};

/**
 * A Shopify storefront prices in the *viewer's* market, not the brand's.
 *
 * Ingesting Wolf Tooth from India returned INR — "1500.00" where the brand's own price is
 * $14.95 — and we stored those figures under a hardcoded USD label. The agent would have
 * quoted a $15 part as $1,500.
 *
 * `/meta.json` reports the shop's canonical currency, and the response's `cart_currency`
 * cookie reports what was actually served. Both are checked, because requesting a market
 * does not reliably get you one.
 */
async function shopCurrency(domain: string): Promise<{ currency: string; country: string | null }> {
  try {
    const { res, body } = await safeFetch(`https://${domain}/meta.json`, {
      timeoutMs: 8000,
      accept: 'application/json',
    });
    if (res.ok) {
      const meta = JSON.parse(body) as { currency?: string; country?: string };
      if (meta.currency) return { currency: meta.currency, country: meta.country ?? null };
    }
  } catch {
    /* fall through to the default below */
  }
  return { currency: 'USD', country: null };
}

function servedCurrency(res: Response): string | null {
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.match(/cart_currency=([A-Z]{3})/)?.[1] ?? null;
}

export class CurrencyMismatchError extends Error {}

/** A median above this suggests minor units or a currency mix-up rather than real pricing. */
const IMPLAUSIBLE_MEDIAN_CENTS = 150_000;

const POLICY_PATHS: { path: string; kind: PackPolicy['kind'] }[] = [
  { path: '/policies/shipping-policy', kind: 'shipping' },
  { path: '/policies/refund-policy', kind: 'returns' },
  { path: '/policies/terms-of-service', kind: 'terms' },
  { path: '/pages/faq', kind: 'faq' },
  { path: '/pages/about', kind: 'about' },
];

async function fetchAllProducts(
  domain: string,
  currency: string,
  onProgress: OnProgress,
): Promise<ShopifyProduct[]> {
  const out: ShopifyProduct[] = [];
  for (let page = 1; page <= 20; page++) {
    const { res, body } = await safeFetch(
      `https://${domain}/products.json?limit=250&page=${page}`,
      {
        timeoutMs: 20_000,
        accept: 'application/json',
      },
    );
    if (!res.ok) break;

    const served = servedCurrency(res);
    if (served && served !== currency) {
      throw new CurrencyMismatchError(
        `${domain} served prices in ${served} but the shop's currency is ${currency}. ` +
          `Ingesting would store the wrong figures, so it was stopped.`,
      );
    }
    const parsed = JSON.parse(body) as { products: ShopifyProduct[] };
    if (!parsed.products?.length) break;
    out.push(...parsed.products);
    onProgress({ type: 'stage', stage: 'products', detail: `page ${page} — ${out.length} so far` });
    if (parsed.products.length < 250) break;
  }
  return out;
}

const POLICY_CHAR_LIMIT = 20_000;

/** Refuse to strip a document if the heuristic wants to remove more than this share. */
const MAX_CHROME_SHARE = 0.4;

/**
 * Policy pages are whole rendered pages, so most of what comes back is the site's nav,
 * cookie banner, footer and newsletter pitch rather than policy. That boilerplate repeats
 * across every page from the same site, so lines appearing in nearly all of them are
 * dropped — 13% to 35% of the corpus across the brands tested.
 *
 * It is not only wasted context. A cookie banner or a marketing line sitting inside the
 * text the agent treats as authoritative is a source of confident nonsense.
 */
function stripSharedChrome<T extends { kind: PackPolicy['kind']; text: string }>(
  docs: T[],
): { docs: T[]; removedChars: number } {
  if (docs.length < 2) return { docs, removedChars: 0 };

  const appearances = new Map<string, number>();
  for (const doc of docs) {
    for (const line of new Set(doc.text.split('\n').map((l) => l.trim()).filter(Boolean))) {
      appearances.set(line, (appearances.get(line) ?? 0) + 1);
    }
  }

  /*
   * A line must appear in *every* document to count as chrome. Requiring only "most"
   * removed ONEHOPE's actual shipping policy, which they repeat across their shipping page
   * and their FAQ — the corpus shrank from 3,036 characters to 31 and nothing said so.
   */
  const chrome = new Set(
    [...appearances.entries()]
      .filter(([line, count]) => count === docs.length && line.length < 120)
      .map(([line]) => line),
  );

  let removedChars = 0;
  const cleaned = docs.map((doc) => {
    const kept: string[] = [];
    let dropped = 0;
    for (const line of doc.text.split('\n')) {
      if (chrome.has(line.trim())) dropped += line.length + 1;
      else kept.push(line);
    }

    // If stripping would gut a document, the heuristic is wrong for this site and the
    // original is kept. Losing a policy silently is far worse than carrying some chrome.
    if (dropped > doc.text.length * MAX_CHROME_SHARE) return doc;

    removedChars += dropped;
    return { ...doc, text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
  });

  return { docs: cleaned, removedChars };
}

async function fetchPolicies(domain: string, onProgress: OnProgress) {
  const fetched: { kind: PackPolicy['kind']; text: string; sourceUrl: string }[] = [];
  const missing: string[] = [];

  await Promise.all(
    POLICY_PATHS.map(async ({ path, kind }) => {
      try {
        const { res, body } = await safeFetch(`https://${domain}${path}`, { timeoutMs: 10_000 });
        const text = stripHtml(body);
        // A 200 that renders a shell page is a miss, not a hit.
        if (res.ok && text.length > 400) {
          fetched.push({ kind, text, sourceUrl: `https://${domain}${path}` });
        } else {
          missing.push(`${kind} (${path} returned ${res.status}, ${text.length} chars)`);
        }
      } catch (e) {
        missing.push(`${kind} (${path}: ${(e as Error).message})`);
      }
    }),
  );

  const { docs: cleaned, removedChars } = stripSharedChrome(fetched);
  if (removedChars > 0) {
    onProgress({
      type: 'stage',
      stage: 'policies',
      detail: `removed ${removedChars.toLocaleString()} chars of shared page chrome`,
    });
  }

  const found: PackPolicy[] = cleaned.map((doc, i) => {
    const truncated = doc.text.length > POLICY_CHAR_LIMIT;
    // Truncation used to be silent, which made every brand's terms exactly 20,000
    // characters long and nobody any the wiser.
    if (truncated) {
      missing.push(
        `${doc.kind} truncated at ${POLICY_CHAR_LIMIT.toLocaleString()} of ${doc.text.length.toLocaleString()} chars`,
      );
    }
    return {
      kind: doc.kind,
      text: doc.text.slice(0, POLICY_CHAR_LIMIT),
      sourceUrl: fetched[i].sourceUrl,
    };
  });

  onProgress({ type: 'count', label: 'policies', value: found.length });
  return { found, missing };
}

/**
 * Promotions the brand states on its own site. Everything else is unauthorised.
 *
 * This used to look only for free-shipping thresholds, which meant ONEHOPE's "15% off
 * sitewide through September 11" — announced on their homepage and applied automatically at
 * checkout — was invisible. The agent then told customers there were no discounts while the
 * brand was running one, understating them and contradicting their own front page.
 */
const OFFER_PATTERNS: RegExp[] = [
  // "15% off sitewide", "Up to 20% Off + Free Shipping", "50% off The Harvest Table Trio"
  /(?:up to\s+)?\d{1,2}\s?%\s+off[^.\n|]{0,60}/gi,
  // "Free shipping over $75"
  /free\s+(?:standard\s+)?shipping\s+(?:on\s+)?(?:orders\s+)?(?:over|above|of)\s+\$?\d{2,4}/gi,
];

const OFFER_NOISE = /\b(cookie|privacy|terms|unsubscribe|sign in|log in)\b/i;

function extractOffers(sources: string[]): { offers: string[]; freeShipThreshold?: number } {
  const offers = new Set<string>();
  let threshold: number | undefined;

  for (const src of sources) {
    for (const pattern of OFFER_PATTERNS) {
      for (const m of src.matchAll(pattern)) {
        const text = m[0].replace(/\s+/g, ' ').trim().replace(/[,;]$/, '');
        if (text.length < 6 || text.length > 90 || OFFER_NOISE.test(text)) continue;
        offers.add(text);
      }
    }
    for (const m of src.matchAll(/free\s+(?:standard\s+)?shipping\s+(?:on\s+)?(?:orders\s+)?(?:over|above|of)\s+\$?(\d{2,4})/gi)) {
      threshold = Math.min(threshold ?? Infinity, Number(m[1]) * 100);
    }
  }

  // Longest first: "15% off sitewide through September 11" beats a bare "15% off".
  const ranked = [...offers].sort((a, b) => b.length - a.length).slice(0, 6);
  return { offers: ranked, freeShipThreshold: threshold };
}

function extractRestrictedRegions(policyText: string): string[] {
  const regions = new Set<string>();
  const re = /(?:cannot|can not|do not|don't|unable to|not able to)\s+ship\s+(?:wine\s+)?(?:to|into)\s+([^.;]{3,160})/gi;
  for (const m of policyText.matchAll(re)) {
    for (const part of m[1].split(/,| or | and /i)) {
      const name = part.replace(/\b(the|state of|states|following)\b/gi, '').trim();
      if (name.length >= 2 && name.length <= 30 && /^[A-Za-z .'-]+$/.test(name)) regions.add(name);
    }
  }
  return [...regions].slice(0, 30);
}

export async function ingestShopify(domain: string, onProgress: OnProgress): Promise<ContextPack> {
  onProgress({ type: 'stage', stage: 'brand', detail: 'reading homepage, logo, palette, vendor' });
  const meta = await fetchBrandMeta(domain);
  if (meta.smsVendor) onProgress({ type: 'stage', stage: 'vendor', detail: meta.smsVendor });

  onProgress({ type: 'stage', stage: 'mcp', detail: 'checking for a storefront MCP endpoint' });
  const mcpTools = await discoverMcpTools(domain);
  onProgress({
    type: 'stage',
    stage: 'mcp',
    detail: mcpTools.length ? mcpTools.join(', ') : 'none exposed',
  });

  onProgress({ type: 'stage', stage: 'currency', detail: 'reading the shop\'s own currency' });
  const { currency, country } = await shopCurrency(domain);
  onProgress({
    type: 'stage',
    stage: 'currency',
    detail: `${currency}${country ? ` (${country})` : ''}`,
  });

  onProgress({ type: 'stage', stage: 'products', detail: 'paginating products.json' });
  const raw = await fetchAllProducts(domain, currency, onProgress);
  onProgress({ type: 'count', label: 'products found', value: raw.length });

  onProgress({ type: 'stage', stage: 'policies', detail: 'shipping, returns, terms, faq' });
  const { found: policies, missing } = await fetchPolicies(domain, onProgress);
  for (const m of missing) onProgress({ type: 'warn', message: `not found: ${m}` });

  const products: PackProduct[] = raw.map((p) => {
    const v = p.variants?.[0];
    return {
      sku: v?.sku || null,
      variantId: v ? String(v.id) : null,
      title: p.title,
      priceCents: Math.round(parseFloat(v?.price ?? '0') * 100),
      currency,
      available: (p.variants ?? []).some((x) => x.available),
      productType: p.product_type || null,
      tags: p.tags ?? [],
      description: stripHtml(p.body_html).slice(0, 4000),
      url: `https://${domain}/products/${p.handle}`,
      imageUrl: p.images?.[0]?.src ?? null,
    };
  });

  /*
   * A price distribution, reported rather than assumed correct.
   *
   * The INR ingest stored a $54.95 part as $5,400 and every downstream rail passed, because
   * the rails check the model and nothing was checking the ingest. The currency guard makes
   * that specific failure impossible; this makes the next one visible, whatever its cause.
   */
  const prices = products.map((p) => p.priceCents).filter((c) => c > 0).sort((a, b) => a - b);
  if (prices.length) {
    const median = prices[Math.floor(prices.length / 2)];
    onProgress({
      type: 'stage',
      stage: 'prices',
      detail: `${currency} ${(prices[0] / 100).toFixed(2)} – ${(prices[prices.length - 1] / 100).toFixed(2)}, median ${(median / 100).toFixed(2)}`,
    });
    if (median > IMPLAUSIBLE_MEDIAN_CENTS) {
      onProgress({
        type: 'warn',
        message: `median price is ${currency} ${(median / 100).toFixed(2)} — unusually high for consumer goods, check the currency`,
      });
    }
  }

  const policyText = policies.map((p) => p.text).join('\n');
  const { offers, freeShipThreshold } = extractOffers([stripHtml(meta.html), policyText]);
  if (offers.length) {
    onProgress({ type: 'stage', stage: 'offers', detail: offers.slice(0, 3).join(' · ') });
  }
  const restrictedRegions = extractRestrictedRegions(policyText);
  const category = classifyCategory(meta.html, products.map((p) => p.title));

  if (!meta.logoUrl) missing.push('logo (no og:image on the homepage)');
  if (!offers.length) missing.push('on-site offers (agent may not offer anything)');
  if (category === 'alcohol' && !restrictedRegions.length) {
    missing.push('restricted shipping regions (alcohol brand — agent will escalate on region questions)');
  }

  return {
    brand: {
      name: meta.name ?? domain,
      domain,
      currency,
      logoUrl: meta.logoUrl,
      palette: meta.palette,
      category,
      smsVendor: meta.smsVendor,
      ingestPath: 'shopify',
      mcpTools,
    },
    products,
    policies,
    offers,
    restrictedRegions,
    freeShipThreshold,
    missing,
  };
}
