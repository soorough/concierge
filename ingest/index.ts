import { preflight } from './preflight.js';
import { ingestShopify } from './shopify.js';
import { saveContextPack, getBrandByDomain } from '../store/queries.js';
import { normaliseDomain } from './fetch.js';
import type { OnProgress } from './types.js';

export { preflight };

export type IngestResult = {
  brandId: string;
  domain: string;
  path: string;
  total: number;
  excluded: number;
  sellable: number;
  cached: boolean;
  ingestedAt: number;
};

/**
 * Cache policy: results are cached per domain with the ingest timestamp visible, and
 * `force` genuinely re-runs. A cache holds real output from a real fetch — nothing is
 * ever served that did not come from one.
 */
export async function ingestDomain(
  input: string,
  onProgress: OnProgress,
  opts: { force?: boolean } = {},
): Promise<IngestResult> {
  const domain = normaliseDomain(input);

  if (!opts.force) {
    const cached = getBrandByDomain(domain);
    if (cached) {
      onProgress({ type: 'stage', stage: 'cache', detail: `ingested ${new Date(cached.ingested_at).toISOString()}` });
      onProgress({ type: 'done', brandId: cached.id });
      return {
        brandId: cached.id, domain, path: cached.ingest_path,
        total: cached.products_total, excluded: cached.products_excluded,
        sellable: cached.products_total - cached.products_excluded,
        cached: true, ingestedAt: cached.ingested_at,
      };
    }
  }

  onProgress({ type: 'stage', stage: 'preflight', detail: 'classifying domain' });
  const pre = await preflight(domain);
  onProgress({ type: 'stage', stage: 'preflight', detail: pre.detail });

  if (pre.path === 'blocked') {
    onProgress({ type: 'error', message: pre.detail });
    throw new Error(pre.detail);
  }
  if (pre.path === 'crawl') {
    const msg = 'Crawl adapter not implemented yet — Shopify path only.';
    onProgress({ type: 'error', message: msg });
    throw new Error(msg);
  }

  const pack = await ingestShopify(domain, onProgress);

  onProgress({ type: 'stage', stage: 'store', detail: 'writing context pack' });
  const { brandId, total, excluded } = saveContextPack(pack);

  onProgress({ type: 'count', label: 'sellable', value: total - excluded });
  onProgress({ type: 'count', label: 'excluded', value: excluded });
  onProgress({ type: 'done', brandId });

  return {
    brandId, domain, path: pre.path, total, excluded,
    sellable: total - excluded, cached: false, ingestedAt: Date.now(),
  };
}
