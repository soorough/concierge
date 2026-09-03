import { safeFetch, normaliseDomain, BlockedTargetError } from './fetch.js';
import type { PreflightResult } from './types.js';

/** WAF interstitials return 200 or 403 with a recognisable body rather than a real error. */
const WALLS: { name: string; test: (body: string) => boolean }[] = [
  { name: 'imperva', test: (b) => /Pardon Our Interruption|_Incapsula_|reeseSkipExpirationCheck/i.test(b) },
  { name: 'cloudflare', test: (b) => /Just a moment\.\.\.|cf-browser-verification|__cf_chl/i.test(b) },
  { name: 'akamai', test: (b) => /Reference #\d+\.\w+|akamai-bot/i.test(b) },
  { name: 'datadome', test: (b) => /datadome|geo\.captcha-delivery\.com/i.test(b) },
];

function detectWall(body: string, status: number): string | null {
  for (const w of WALLS) if (w.test(body)) return w.name;
  if (status === 403 || status === 401) return 'forbidden';
  return null;
}

type Probe = { ok: boolean; status: number; body: string; error?: Error };

async function probe(url: string): Promise<Probe> {
  try {
    const { res, body } = await safeFetch(url, { timeoutMs: 6000 });
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e as Error };
  }
}

/**
 * Classify a domain before committing to a full ingest, so a slow crawl never looks like
 * a hang and an unreachable site fails immediately with the wall named.
 *
 * The three probes run concurrently and are then read in priority order — sequential
 * probing cost ~7s on a site that 404s the first two (thorne.com).
 */
export async function preflight(input: string): Promise<PreflightResult> {
  const started = Date.now();
  const domain = normaliseDomain(input);
  const ms = () => Date.now() - started;

  const [shop, sitemap, home] = await Promise.all([
    probe(`https://${domain}/products.json?limit=1`),
    probe(`https://${domain}/sitemap.xml`),
    probe(`https://${domain}/`),
  ]);

  const blocked = (wall: string, detail?: string): PreflightResult => ({
    domain, path: 'blocked', wall, ms: ms(),
    detail: detail ?? `${domain} is behind a bot wall (${wall}). Ingest needs their cooperation or an API key.`,
  });

  if (shop.error instanceof BlockedTargetError) return blocked('refused', shop.error.message);

  // A wall on the homepage is authoritative; a 403 on products.json alone is not, since
  // plenty of healthy non-Shopify sites refuse that path outright.
  const homeWall = detectWall(home.body, home.status);
  if (homeWall) return blocked(homeWall);
  for (const p of [shop, sitemap]) {
    const w = p.body ? detectWall(p.body, 999) : null;
    if (w) return blocked(w);
  }

  if (shop.ok && shop.body.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(shop.body) as { products?: unknown[] };
      if (Array.isArray(parsed.products)) {
        return {
          domain, path: 'shopify', ms: ms(),
          detail: 'Shopify storefront with an open products.json — structured ingest.',
        };
      }
    } catch { /* not Shopify */ }
  }

  if (sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body)) {
    return {
      domain, path: 'crawl', ms: ms(),
      detail: 'No Shopify API. Sitemap found — crawl + extraction, slower and less complete.',
    };
  }

  if (home.ok && home.body.length > 500) {
    return {
      domain, path: 'crawl', ms: ms(),
      detail: 'No Shopify API and no sitemap. Crawl from the homepage — slowest path.',
    };
  }

  return blocked(
    'unreachable',
    home.status
      ? `${domain} returned ${home.status} with no usable content.`
      : `Could not reach ${domain}: ${home.error?.message ?? 'no response'}`,
  );
}
