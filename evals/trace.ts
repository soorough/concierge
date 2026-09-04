import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}

/**
 * The loop, run against a real brand and a real model.
 *
 * **This costs money.** It makes real model calls, which is why it is its own command and
 * not part of `npm run evals` — that suite is pure logic, needs no key, and must stay free
 * to run constantly.
 *
 * What it shows is the thing the founder's critique was about: which turns take one
 * constrained call, which turns earn a loop, what the loop actually did, and what the
 * difference costs. The router's decision is printed beside the bill for it.
 */
const { getDb } = await import('../store/db.js');
const { runTurn } = await import('../agent/loop.js');
const { toolCallsFor } = await import('../store/session.js');

const brand = getDb()
  .prepare("select * from brand where ingest_path = 'shopify' order by ingested_at desc limit 1")
  .get() as any;
if (!brand) {
  console.error('No Shopify brand ingested. Paste a domain in the console first.');
  process.exit(1);
}

const CASES = [
  'what goes with a ribeye?',
  'how much is your cheapest wine?',
  'do you have the vintner cabernet in stock right now?',
  'compare the prices of your three cheapest wines and tell me which is in stock',
];

console.log(`\n  Trajectories — ${brand.domain}\n`);

let singleCall = 0;
let looped = 0;

for (const message of CASES) {
  const t = await runTurn({
    brand,
    sessionId: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    text: message,
  });
  t.trace.length ? looped++ : singleCall++;

  console.log(`  > ${message}`);
  console.log(
    `    ${t.route} · ${t.modelCalls} model call${t.modelCalls === 1 ? '' : 's'} · ` +
      `${t.trace.length} tool call${t.trace.length === 1 ? '' : 's'} · ` +
      `${t.costCents.toFixed(3)}¢ · ${t.latencyMs}ms`,
  );
  for (const row of toolCallsFor([t.turnId])) {
    console.log(`      ${row.seq}. ${row.tool} ${row.arguments_json} → ${row.source}, ${row.ms}ms`);
  }
  const blocked = t.rails.filter((r) => r.level === 'block');
  if (blocked.length) console.log(`      blocked: ${blocked.map((r) => r.code).join(', ')}`);
  console.log(`      ${JSON.stringify(t.reply)}\n`);
}

console.log(`  ${singleCall} turn(s) took one call, ${looped} earned a loop.\n`);
process.exit(0);
