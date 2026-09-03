import { getDb, id } from './db.js';
import { assessSellability } from '../ingest/sellable.js';
import type { ContextPack } from '../ingest/types.js';

export type StoredBrand = {
  id: string; domain: string; name: string; currency: string;
  logo_url: string | null; palette_json: string | null; category: string;
  ingest_path: string; detected_sms_vendor: string | null;
  free_ship_threshold: number | null; restricted_regions_json: string | null;
  products_total: number; products_excluded: number; missing_json: string | null;
  ingested_at: number;
};

export function getBrandByDomain(domain: string): StoredBrand | undefined {
  return getDb().prepare('select * from brand where domain = ?').get(domain) as StoredBrand | undefined;
}

/**
 * Replace a brand's pack atomically. Re-ingest is a full replace rather than a merge:
 * a partially-updated catalog is worse than a stale one, because the agent would quote
 * from a mixture of two crawls.
 */
export function saveContextPack(pack: ContextPack): { brandId: string; total: number; excluded: number } {
  const db = getDb();
  const existing = getBrandByDomain(pack.brand.domain);
  const brandId = existing?.id ?? id('brand');

  const counts = { total: pack.products.length, excluded: 0 };

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare('delete from product where brand_id = ?').run(brandId);
      db.prepare('delete from policy_chunk where brand_id = ?').run(brandId);
    }

    db.prepare(`
      insert into brand (id, domain, name, currency, logo_url, palette_json, category,
                         ingest_path, detected_sms_vendor, free_ship_threshold,
                         restricted_regions_json, products_total, products_excluded,
                         missing_json, ingested_at)
      values (@id,@domain,@name,@currency,@logo_url,@palette_json,@category,@ingest_path,
              @vendor,@threshold,@regions,@total,@excluded,@missing,@at)
      on conflict(domain) do update set
        name=excluded.name, currency=excluded.currency, logo_url=excluded.logo_url,
        palette_json=excluded.palette_json, category=excluded.category,
        ingest_path=excluded.ingest_path, detected_sms_vendor=excluded.detected_sms_vendor,
        free_ship_threshold=excluded.free_ship_threshold,
        restricted_regions_json=excluded.restricted_regions_json,
        products_total=excluded.products_total, products_excluded=excluded.products_excluded,
        missing_json=excluded.missing_json, ingested_at=excluded.ingested_at
    `).run({
      id: brandId, domain: pack.brand.domain, name: pack.brand.name,
      currency: pack.brand.currency, logo_url: pack.brand.logoUrl,
      palette_json: JSON.stringify(pack.brand.palette), category: pack.brand.category,
      ingest_path: pack.brand.ingestPath, vendor: pack.brand.smsVendor,
      threshold: pack.freeShipThreshold ?? null,
      regions: JSON.stringify(pack.restrictedRegions),
      total: counts.total, excluded: 0,
      missing: JSON.stringify(pack.missing), at: Date.now(),
    });

    const insProduct = db.prepare(`
      insert into product (id, brand_id, sku, variant_id, title, price_cents, currency,
                           available, sellable, excluded_reason, product_type, tags_json,
                           description, url, image_url)
      values (@id,@brand_id,@sku,@variant_id,@title,@price_cents,@currency,@available,
              @sellable,@excluded_reason,@product_type,@tags_json,@description,@url,@image_url)
    `);

    for (const p of pack.products) {
      const verdict = assessSellability({
        priceCents: p.priceCents, available: p.available, productType: p.productType,
      });
      if (!verdict.sellable) counts.excluded++;
      insProduct.run({
        id: id('prod'), brand_id: brandId, sku: p.sku, variant_id: p.variantId,
        title: p.title, price_cents: p.priceCents, currency: p.currency,
        available: p.available ? 1 : 0, sellable: verdict.sellable ? 1 : 0,
        excluded_reason: verdict.reason, product_type: p.productType,
        tags_json: JSON.stringify(p.tags), description: p.description,
        url: p.url, image_url: p.imageUrl,
      });
    }

    const insPolicy = db.prepare(`
      insert into policy_chunk (id, brand_id, kind, text, source_url)
      values (?,?,?,?,?)
    `);
    for (const pol of pack.policies) {
      // Chunk long policies so FTS returns a relevant passage, not a whole document.
      for (const chunk of chunkText(pol.text, 1200)) {
        insPolicy.run(id('pol'), brandId, pol.kind, chunk, pol.sourceUrl);
      }
    }

    db.prepare('update brand set products_excluded = ? where id = ?').run(counts.excluded, brandId);
  });

  tx();
  return { brandId, total: counts.total, excluded: counts.excluded };
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let buf = '';
  for (const s of sentences) {
    if ((buf + ' ' + s).length > size && buf) {
      out.push(buf.trim());
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
