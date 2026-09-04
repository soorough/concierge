import { getDb } from '../store/db.js';
import { resolvePrice, checkAvailability, clearLiveCache } from '../agent/tools.js';
import { runPostRails, formatMoney, type LivePriceEntry } from '../agent/rails/post.js';
import type { RetrievedProduct } from '../agent/retrieve.js';
import type { StoredBrand } from '../store/queries.js';

/**
 * The live-truth check, run against a real storefront.
 *
 * Deliberately not part of `npm run evals`. That suite is pure logic with no network and no
 * API key, which is what makes it trustworthy in CI and fast enough to run constantly. This
 * one asks a real brand's real store real questions, so it is slower, it can fail for
 * reasons that are not our fault, and it belongs behind its own command.
 *
 * What it proves is the thing the snapshot could not: a price the customer is quoted comes
 * from the store as it is now, not from the catalog as it was at ingest.
 */

const line = (label: string, value: string) => console.log(`  ${label.padEnd(34)} ${value}`);

async function main() {
  const db = getDb();
  const brand = db
    .prepare("select * from brand where ingest_path = 'shopify' order by ingested_at desc limit 1")
    .get() as StoredBrand | undefined;

  if (!brand) {
    console.error('No Shopify brand has been ingested. Paste a domain in the console first.');
    process.exit(1);
  }

  const product = db
    .prepare(
      `select id, sku, variant_id, title, price_cents, currency, available, product_type,
              description, url, image_url
       from product
       where brand_id = ? and sellable = 1 and variant_id is not null and url is not null
       order by price_cents desc limit 1`,
    )
    .get(brand.id) as RetrievedProduct | undefined;

  if (!product) {
    console.error(`${brand.domain} has no sellable product with a variant to check.`);
    process.exit(1);
  }

  const currency = brand.currency ?? 'USD';
  console.log(`\n  Live truth — ${brand.domain}\n`);
  line('product', product.title);
  line('snapshot price (from ingest)', formatMoney(product.price_cents, currency));

  // --- 1. the live lookup itself
  clearLiveCache();
  const priced = await resolvePrice({
    domain: brand.domain,
    ingestPath: brand.ingest_path,
    product,
  });

  line('live price (from the store)', formatMoney(priced.value.priceCents, currency));
  line('source', priced.source);
  line('round trip', `${priced.ms}ms`);

  if (priced.source !== 'live') {
    console.error(`\n  FAIL  the store did not answer: ${priced.detail}\n`);
    process.exit(1);
  }

  const stock = await checkAvailability({
    domain: brand.domain,
    ingestPath: brand.ingest_path,
    product,
  });
  line('live availability', stock.value.available ? 'in stock' : 'out of stock');
  line('cached second lookup', `${(await resolvePrice({ domain: brand.domain, ingestPath: brand.ingest_path, product })).ms}ms`);

  /*
   * --- 2. a store that has moved since ingest
   *
   * We cannot reprice somebody else's shop to order, so the drift is produced from the
   * other side: the live number is real and the snapshot is set to what the catalog would
   * have held had the brand changed the price after we ingested it. That is the same
   * comparison the rail makes, with the same two inputs, in the same direction.
   */
  const staleSnapshot: RetrievedProduct = {
    ...product,
    price_cents: priced.value.priceCents + 500,
  };
  const drifted = new Map<string, LivePriceEntry>([
    [
      product.id,
      {
        priceCents: priced.value.priceCents,
        source: 'live',
        driftCents: staleSnapshot.price_cents - priced.value.priceCents,
        suspect: false,
        stale: false,
      },
    ],
  ]);

  const railed = runPostRails(
    { reply: `${product.title} is {{price:1}}.`, actions: [], learned: [], needs_age_check: false, escalate: null },
    {
      catalog: [staleSnapshot],
      nonSellableSkus: new Set(),
      category: brand.category,
      ageVerified: true,
      restrictedRegions: [],
      customerRegion: null,
      currency,
      livePrices: drifted,
      liveLookupMs: priced.ms,
    },
  );

  console.log('');
  line('stale snapshot would have said', formatMoney(staleSnapshot.price_cents, currency));
  line('what the customer is told', railed.reply);
  for (const e of railed.events) console.log(`  ${e.level.padEnd(5)} ${e.code} · ${e.detail}`);

  const quotesLive = railed.reply.includes(formatMoney(priced.value.priceCents, currency));
  const quotesStale = railed.reply.includes(formatMoney(staleSnapshot.price_cents, currency));
  const reportedDrift = railed.events.some((e) => e.code === 'PRICE_DRIFT');
  const reportedLive = railed.events.some((e) => e.code === 'PRICE_LIVE');

  const ok = quotesLive && !quotesStale && reportedDrift && reportedLive;
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'}  the quoted price is the store's, and the drift is on the record\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
