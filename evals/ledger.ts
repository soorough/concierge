import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// getDb() is lazy, so pointing DB_PATH at a scratch file before the first import gives
// these cases a real database rather than a mock — supersession is exactly the kind of
// logic that looks correct in a fake and behaves otherwise in SQLite.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'concierge-eval-')), 'test.db');

const { migrate, getDb } = await import('../store/db.js');
const { writeFact, currentFacts, allFacts } = await import('../store/ledger.js');

migrate(getDb());

function freshCustomer(id: string) {
  const db = getDb();
  db.prepare(
    `insert or ignore into brand (id,domain,name,category,ingest_path,ingested_at)
     values ('b','x.com','X','general','shopify',0)`,
  ).run();
  db.prepare('insert into customer (id,brand_id,session_id,first_seen) values (?,?,?,?)')
    .run(id, 'b', id, Date.now());
  return id;
}

export type Case = { name: string; run: () => { pass: boolean; got: string } };

export const LEDGER_CASES: Case[] = [
  {
    name: 'a contradiction supersedes rather than duplicating',
    run: () => {
      const c = freshCustomer('c1');
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'bold red', source: 'conversation', confidence: 0.8 });
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'crisp white', source: 'conversation', confidence: 0.9 });
      const cur = currentFacts(c);
      const all = allFacts(c);
      return {
        pass: cur.length === 1 && cur[0].object === 'crisp white' && all.length === 2 &&
              all.some((f) => f.superseded_by !== null),
        got: `${cur.length} current / ${all.length} total / current="${cur[0]?.object}"`,
      };
    },
  },
  {
    name: 'the superseded fact stays readable with its closing timestamp',
    run: () => {
      const c = freshCustomer('c2');
      writeFact({ customerId: c, predicate: 'budget_band', object: 'under $40', source: 'conversation' });
      writeFact({ customerId: c, predicate: 'budget_band', object: 'under $100', source: 'conversation' });
      const old = allFacts(c).find((f) => f.object === 'under $40');
      return {
        pass: Boolean(old && old.valid_to !== null && old.superseded_by !== null),
        got: `valid_to=${old?.valid_to !== null} superseded_by=${old?.superseded_by !== null}`,
      };
    },
  },
  {
    name: 'first-party supersedes a third-party field note',
    run: () => {
      const c = freshCustomer('c3');
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'Cabernet for the office', source: 'field_note', confidence: 0.9 });
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'whites, shopping for my sister', source: 'conversation', confidence: 0.6 });
      const cur = currentFacts(c);
      return {
        pass: cur.length === 1 && cur[0].source === 'conversation',
        got: `current="${cur[0]?.object}" from ${cur[0]?.source}`,
      };
    },
  },
  {
    name: 'a field note does NOT overwrite what the customer said themselves',
    run: () => {
      const c = freshCustomer('c4');
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'whites', source: 'conversation', confidence: 0.6 });
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'reds', source: 'field_note', confidence: 0.99 });
      const cur = currentFacts(c);
      return {
        pass: cur.length === 1 && cur[0].object === 'whites' && cur[0].source === 'conversation',
        got: `current="${cur[0]?.object}" from ${cur[0]?.source}`,
      };
    },
  },
  {
    name: 'an outranked field note is still recorded for the audit trail',
    run: () => {
      const c = freshCustomer('c5');
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'whites', source: 'conversation' });
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'reds', source: 'field_note' });
      const all = allFacts(c);
      const note = all.find((f) => f.source === 'field_note');
      return {
        pass: all.length === 2 && Boolean(note && note.valid_to !== null),
        got: `${all.length} rows, field_note closed=${note?.valid_to !== null}`,
      };
    },
  },
  {
    name: 'restating the same fact does not create a duplicate',
    run: () => {
      const c = freshCustomer('c6');
      writeFact({ customerId: c, predicate: 'gifting', object: 'yes', source: 'conversation' });
      writeFact({ customerId: c, predicate: 'gifting', object: 'Yes', source: 'conversation' });
      return { pass: allFacts(c).length === 1, got: `${allFacts(c).length} rows` };
    },
  },
  {
    name: 'facts on different predicates coexist',
    run: () => {
      const c = freshCustomer('c7');
      writeFact({ customerId: c, predicate: 'prefers_style', object: 'bold red', source: 'conversation' });
      writeFact({ customerId: c, predicate: 'occasion', object: 'anniversary', source: 'conversation' });
      return { pass: currentFacts(c).length === 2, got: `${currentFacts(c).length} current` };
    },
  },
];
