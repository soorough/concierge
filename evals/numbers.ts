/**
 * Every number quoted in the documentation, reprinted from source.
 *
 * Catalogs are live and they drift — ONEHOPE was 122 products one day and 121 the next
 * because they delisted one, and a brand's sellable count changes when something goes out
 * of stock. A figure in a document is true on the day it was measured, so this exists to
 * re-measure rather than to trust the prose.
 *
 *   npm run numbers                                   # local database
 *   MONITOR_URL=https://… CONSOLE_PASSWORD=… npm run numbers
 */
export {};

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getDb, migrate } from '../store/db.js';
import { getMetrics } from '../store/metrics.js';
// Only modules without import-time side effects may be imported here. The ledger and
// retrieval suites repoint DB_PATH at a scratch database when loaded, which would make this
// script confidently report an empty system.
import { PROBES } from './adversarial-cases.js';

const REMOTE = process.env.MONITOR_URL;
const PASSWORD = process.env.CONSOLE_PASSWORD ?? '';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

console.log(`\n  ${bold('Numbers')}  ${dim(new Date().toISOString().slice(0, 10))}\n`);

// The suite itself is the authority on how many cases it has.
const evalOutput = execFileSync('npx', ['tsx', 'evals/run.ts'], { encoding: 'utf8' });
const evalCount = evalOutput.match(/(\d+)\/(\d+) passed/)?.[2] ?? '?';
const evalPassed = evalOutput.match(/(\d+)\/(\d+) passed/)?.[1] ?? '?';

console.log(`  ${dim('tests')}`);
console.log(
  `    deterministic evals   ${evalCount}   ${evalPassed === evalCount ? dim('all passing') : `\x1b[31m${evalPassed} passing\x1b[0m`}   ${dim('npm run evals')}`,
);
console.log(`    adversarial probes    ${PROBES.length}   ${dim('npm run stress')}`);

const railCodes = new Set(
  (readFileSync('agent/rails/post.ts', 'utf8') + readFileSync('agent/rails/pre.ts', 'utf8'))
    .match(/code: '([A-Z_]+)'/g)
    ?.map((m) => m.slice(7, -1)) ?? [],
);
console.log(`    distinct rail codes   ${railCodes.size}`);

type BrandRow = { domain: string; products_total: number; products_excluded: number; ingested_at: number };

if (REMOTE) {
  const headers: Record<string, string> = PASSWORD ? { 'x-console-password': PASSWORD } : {};
  const brands = (await (await fetch(`${REMOTE}/api/brands`, { headers })).json()) as { domain: string }[];
  console.log(`\n  ${dim(`catalogs on ${REMOTE}`)}`);
  for (const { domain } of brands) {
    const b = (await (await fetch(`${REMOTE}/api/brand/${domain}`, { headers })).json()) as {
      counts: { total: number; sellable: number };
      ingested_at: number;
    };
    console.log(
      `    ${domain.padEnd(26)} ${b.counts.total} → ${b.counts.sellable} sellable   ${dim(new Date(b.ingested_at).toISOString().slice(0, 16).replace('T', ' '))}`,
    );
  }
  const m = (await (await fetch(`${REMOTE}/api/metrics?hours=168`, { headers })).json()) as ReturnType<typeof getMetrics>;
  console.log(`\n  ${dim('measured over the last 7 days')}`);
  console.log(`    turns ${m.turnsIn} · model calls ${m.modelCalls}`);
  console.log(`    p50 ${m.latency.p50}ms · p95 ${m.latency.p95}ms · ${m.costPerTurnCents}¢ per turn`);
} else {
  migrate(getDb());
  const brands = getDb()
    .prepare('select domain, products_total, products_excluded, ingested_at from brand order by domain')
    .all() as BrandRow[];

  console.log(`\n  ${dim('catalogs, as last ingested locally')}`);
  for (const b of brands) {
    console.log(
      `    ${b.domain.padEnd(26)} ${b.products_total} → ${b.products_total - b.products_excluded} sellable   ${dim(new Date(b.ingested_at).toISOString().slice(0, 16).replace('T', ' '))}`,
    );
  }

  const m = getMetrics(24 * 30);
  console.log(`\n  ${dim('measured over the last 30 days')}`);
  console.log(`    turns ${m.turnsIn} · model calls ${m.modelCalls}`);
  console.log(`    p50 ${m.latency.p50}ms · p95 ${m.latency.p95}ms · ${m.costPerTurnCents}¢ per turn`);
  console.log(
    `    escalated ${m.rates.escalation}% · blocked ${m.rates.blocked}% · recovered ${m.rates.recovered}%`,
  );
}

console.log(`\n  ${dim('Catalogs are live. A number is true on the day it was measured.')}\n`);
