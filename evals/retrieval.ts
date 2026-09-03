import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'concierge-retr-')), 'test.db');

const { migrate, getDb, id } = await import('../store/db.js');
const { retrieve, toFtsQuery } = await import('../agent/retrieve.js');
const { recordTurn, getOrCreateCustomer } = await import('../store/session.js');

migrate(getDb());

const db = getDb();
db.prepare(
  `insert into brand (id,domain,name,category,ingest_path,ingested_at)
   values ('b1','onehopewine.com','ONEHOPE','alcohol','shopify',0)`,
).run();

const products = [
  ['Vintner Cabernet Sauvignon 2023', 'VCS-2023', 2900, 'Bold dark berry, toffee and vanilla notes.'],
  ['Vintner Chardonnay 2023', 'VCH-2023', 2700, 'Crisp apple and citrus.'],
  ['Reserve Paso Robles Cabernet Sauvignon', 'RPR-CAB', 4000, 'Structured and age-worthy.'],
] as const;
// Padding past the small-catalog threshold so the FTS path is what is under test.
for (let i = 0; i < 70; i++) {
  db.prepare(
    `insert into product (id,brand_id,sku,variant_id,title,price_cents,currency,available,sellable,product_type,tags_json,description,url)
     values (?,?,?,?,?,?,?,1,1,'Wine','[]',?,?)`,
  ).run(id('p'), 'b1', `FILLER-${i}`, `9${i}`, `Filler Wine ${i}`, 1000 + i, 'USD', 'A filler wine.', 'https://x/p');
}
for (const [title, sku, price, desc] of products) {
  db.prepare(
    `insert into product (id,brand_id,sku,variant_id,title,price_cents,currency,available,sellable,product_type,tags_json,description,url)
     values (?,?,?,?,?,?,?,1,1,'Wine','[]',?,?)`,
  ).run(id('p'), 'b1', sku, '111', title, price, 'USD', desc, 'https://x/p');
}

export type Case = { name: string; run: () => { pass: boolean; got: string } };

const titles = (r: { products: { title: string }[] }) => r.products.map((p) => p.title);

export const RETRIEVAL_CASES: Case[] = [
  {
    name: 'FTS query is built safely from raw user text',
    run: () => {
      const q = toFtsQuery("what's the price of the Vintner Cabernet?");
      return { pass: Boolean(q && q.includes('"vintner"') && !q.includes("'")), got: String(q) };
    },
  },
  {
    name: 'a direct product question retrieves that product',
    run: () => {
      const c = getOrCreateCustomer('b1', 's-direct');
      const r = retrieve({ brandId: 'b1', customerId: c.id, message: 'how much is the Vintner Cabernet Sauvignon 2023?' });
      return { pass: titles(r).includes('Vintner Cabernet Sauvignon 2023'), got: titles(r).slice(0, 3).join(', ') };
    },
  },
  {
    /*
     * Regression. A follow-up carries no product terms, so querying the latest message
     * alone returned a catalog slice without the wine under discussion — and the
     * no-invented-SKU rule then made the agent deny carrying something it sells.
     */
    name: 'a follow-up with no product terms still retrieves the wine under discussion',
    run: () => {
      const c = getOrCreateCustomer('b1', 's-followup');
      recordTurn({ customerId: c.id, direction: 'in', text: 'how much is the Vintner Cabernet Sauvignon 2023?' });
      recordTurn({ customerId: c.id, direction: 'out', text: 'It is $29.00.' });
      const r = retrieve({ brandId: 'b1', customerId: c.id, message: 'great, add one bottle and check me out' });
      return { pass: titles(r).includes('Vintner Cabernet Sauvignon 2023'), got: titles(r).slice(0, 3).join(', ') || '(empty)' };
    },
  },
  {
    name: 'non-sellable products never reach the model',
    run: () => {
      db.prepare(
        `insert into product (id,brand_id,sku,variant_id,title,price_cents,currency,available,sellable,excluded_reason,product_type,tags_json,description,url)
         values (?,?,?,?,?,?,?,1,0,'price=0','Component','[]',?,?)`,
      ).run(id('p'), 'b1', 'SHIPPER-6', '222', '6 Bottle Shipper', 0, 'USD', 'Packaging.', 'https://x/p');
      const c = getOrCreateCustomer('b1', 's-junk');
      const r = retrieve({ brandId: 'b1', customerId: c.id, message: 'do you have a bottle shipper?' });
      return { pass: !titles(r).includes('6 Bottle Shipper'), got: titles(r).slice(0, 3).join(', ') || '(empty)' };
    },
  },
];

RETRIEVAL_CASES.push({
  /*
   * Regression. "give me that one" refers to something the agent named, not the
   * customer, so folding in only inbound messages still starved retrieval and the
   * agent escalated on a wine it had recommended one turn earlier.
   */
  name: 'a referent named only by the agent survives into the next turn',
  run: () => {
    const c = getOrCreateCustomer('b1', 's-referent');
    recordTurn({ customerId: c.id, direction: 'in', text: 'what is your cheapest?' });
    recordTurn({ customerId: c.id, direction: 'out', text: 'The Vintner Chardonnay 2023 is our most affordable at $27.00.' });
    const r = retrieve({ brandId: 'b1', customerId: c.id, message: 'okay give me that one' });
    return {
      pass: r.products.some((p) => p.title === 'Vintner Chardonnay 2023'),
      got: r.products.map((p) => p.title).slice(0, 3).join(', ') || '(empty)',
    };
  },
});

RETRIEVAL_CASES.push({
  /*
   * Regression. The token cap is applied after deduplication because a real conversation
   * repeats itself: undeduplicated, twelve slots filled with filler from the newest
   * message and the product name in the agent's reply never reached the index.
   */
  name: 'a referent survives a long, repetitive conversation',
  run: () => {
    const c = getOrCreateCustomer('b1', 's-long');
    const chatter = [
      'yo whats up I want a cheap ass wine please help me out here',
      'okay cool sounds good what else have you got for me today',
      'right okay give me something good then please',
    ];
    for (const m of chatter) {
      recordTurn({ customerId: c.id, direction: 'in', text: m });
      recordTurn({ customerId: c.id, direction: 'out', text: 'Sure, happy to help with that.' });
    }
    recordTurn({ customerId: c.id, direction: 'out', text: 'Our cheapest is the Vintner Chardonnay 2023 at $27.00.' });
    const r = retrieve({ brandId: 'b1', customerId: c.id, message: 'okay give me that one then please' });
    return {
      pass: r.products.some((p) => p.title === 'Vintner Chardonnay 2023'),
      got: r.products.map((p) => p.title).slice(0, 3).join(', ') || '(empty)',
    };
  },
});
