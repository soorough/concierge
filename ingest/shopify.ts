import { safeFetch } from './fetch.js';
import { stripHtml } from './text.js';
import { fetchBrandMeta, classifyCategory } from './brandmeta.js';
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

async function fetchPolicies(domain: string, onProgress: OnProgress) {
  const found: PackPolicy[] = [];
  const missing: string[] = [];
  await Promise.all(
    POLICY_PATHS.map(async ({ path, kind }) => {
      try {
        const { res, body } = await safeFetch(`https://${domain}${path}`, { timeoutMs: 10_000 });
        const text = stripHtml(body);
        // A 200 that renders a shell page is a miss, not a hit.
        if (res.ok && text.length > 400) {
          found.push({ kind, text: text.slice(0, 20_000), sourceUrl: `https://${domain}${path}` });
        } else {
          missing.push(`${kind} (${path} returned ${res.status}, ${text.length} chars)`);
        }
      } catch (e) {
        missing.push(`${kind} (${path}: ${(e as Error).message})`);
      }
    }),
  );
  onProgress({ type: 'count', label: 'policies', value: found.length });
  return { found, missing };
}

/** Only what is stated on-site. Everything the agent might otherwise offer is unauthorised. */
function extractOffers(sources: string[]): { offers: string[]; freeShipThreshold?: number } {
  const offers = new Set<string>();
  let threshold: number | undefined;
  for (const src of sources) {
    for (const m of src.matchAll(/free\s+(?:standard\s+)?shipping\s+(?:on\s+)?(?:orders\s+)?(?:over|above|of)\s+\$?(\d{2,4})/gi)) {
      threshold = Math.min(threshold ?? Infinity, Number(m[1]) * 100);
      offers.add(`Free shipping over $${m[1]}`);
    }
  }
  return { offers: [...offers], freeShipThreshold: threshold };
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

  const policyText = policies.map((p) => p.text).join('\n');
  const { offers, freeShipThreshold } = extractOffers([meta.html, policyText]);
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
    },
    products,
    policies,
    offers,
    restrictedRegions,
    freeShipThreshold,
    missing,
  };
}
