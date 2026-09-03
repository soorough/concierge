import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { migrate, id } from '../store/db.js';
import { assessSellability } from '../ingest/sellable.js';

const raw = JSON.parse(readFileSync('fixtures/onehopewine.com.raw.json', 'utf8'));
const d = new Database(':memory:');
migrate(d as any);

const brandId = id('brand');
d.prepare(`insert into brand (id,domain,name,currency,category,ingest_path,ingested_at)
           values (?,?,?,?,?,?,?)`)
 .run(brandId, 'onehopewine.com', 'ONEHOPE Wine', 'USD', 'alcohol', 'shopify', Date.now());

const ins = d.prepare(`insert into product
  (id,brand_id,sku,variant_id,title,price_cents,currency,available,sellable,excluded_reason,
   product_type,tags_json,description,url,image_url)
  values (@id,@brand_id,@sku,@variant_id,@title,@price_cents,@currency,@available,@sellable,
          @excluded_reason,@product_type,@tags_json,@description,@url,@image_url)`);

const strip = (h: string) => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
let sellableCount = 0;

const load = d.transaction((products: any[]) => {
  for (const p of products) {
    const v = p.variants?.[0];
    const priceCents = Math.round(parseFloat(v?.price ?? '0') * 100);
    const available = (p.variants ?? []).some((x: any) => x.available);
    const verdict = assessSellability({ priceCents, available, productType: p.product_type });
    if (verdict.sellable) sellableCount++;
    ins.run({
      id: id('prod'), brand_id: brandId, sku: v?.sku ?? null,
      variant_id: v ? String(v.id) : null, title: p.title,
      price_cents: priceCents, currency: 'USD',
      available: available ? 1 : 0, sellable: verdict.sellable ? 1 : 0,
      excluded_reason: verdict.reason,
      product_type: p.product_type ?? null,
      tags_json: JSON.stringify(p.tags ?? []),
      description: strip(p.body_html).slice(0, 4000),
      url: `https://onehopewine.com/products/${p.handle}`,
      image_url: p.images?.[0]?.src ?? null,
    });
  }
});
load(raw);

const total = d.prepare('select count(*) c from product').get() as any;
const ftsRows = d.prepare('select count(*) c from product_fts').get() as any;
console.log(`products inserted: ${total.c}   sellable: ${sellableCount}   excluded: ${total.c - sellableCount}`);
console.log(`product_fts rows:  ${ftsRows.c}   ${ftsRows.c === total.c ? 'TRIGGERS OK' : 'TRIGGERS BROKEN'}`);

for (const q of ['cabernet', 'sauvignon blanc', 'chardonnay', 'trio']) {
  const hits = d.prepare(`
    select p.title, p.price_cents, p.sellable
    from product_fts f join product p on p.rowid = f.rowid
    where product_fts match ? and p.sellable = 1
    order by bm25(product_fts) limit 3`).all(q) as any[];
  console.log(`\nFTS "${q}" -> ${hits.length} hits`);
  for (const h of hits) console.log(`   $${(h.price_cents/100).toFixed(2)}  ${h.title.slice(0,54)}`);
}

const junk = d.prepare(`select count(*) c from product_fts f join product p on p.rowid=f.rowid
                        where product_fts match 'shipper OR crinkle' and p.sellable=1`).get() as any;
console.log(`\nsellable junk leaking through ("shipper"/"crinkle"): ${junk.c}  ${junk.c===0?'CLEAN':'LEAK'}`);

d.prepare('delete from product where sellable = 0').run();
const afterDel = d.prepare('select count(*) c from product_fts').get() as any;
const afterProd = d.prepare('select count(*) c from product').get() as any;
console.log(`after deleting excluded: product=${afterProd.c} fts=${afterDel.c}  ${afterProd.c===afterDel.c?'DELETE TRIGGER OK':'DELETE TRIGGER BROKEN'}`);
