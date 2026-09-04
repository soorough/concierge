import { RAIL_CASES } from './rails.js';
import { LEDGER_CASES } from './ledger.js';
import { RETRIEVAL_CASES } from './retrieval.js';
import { AGENT_CASES } from './agent.js';

type Case = { name: string; run: () => { pass: boolean; got: string } };

function section(title: string, cases: Case[]): { passed: number; total: number } {
  console.log(`\n  ${title}\n`);
  let passed = 0;
  for (const c of cases) {
    let ok = false;
    let got = '';
    try {
      const r = c.run();
      ok = r.pass;
      got = r.got;
    } catch (e) {
      got = `threw: ${(e as Error).message}`;
    }
    if (ok) passed++;
    console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${c.name}`);
    if (!ok) console.log(`        got: ${got.slice(0, 140)}`);
  }
  return { passed, total: cases.length };
}

const a = section('Rails — deterministic, no model call', RAIL_CASES);
const b = section('Fact ledger — real database, supersession and provenance', LEDGER_CASES);

const c = section('Retrieval — real FTS index over a real catalog', RETRIEVAL_CASES);
const d = section('Agent — routing, the tool surface, and the store-checked cart', AGENT_CASES);

const passed = a.passed + b.passed + c.passed + d.passed;
const total = a.total + b.total + c.total + d.total;
console.log(`\n  ${passed}/${total} passed\n`);
process.exit(passed === total ? 0 : 1);
