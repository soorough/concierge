/**
 * Production monitor.
 *
 * `npm run evals` proves the rails behave; this asks whether the running system is
 * behaving. It reads live telemetry, checks it against written-down thresholds, and exits
 * non-zero when one is breached, so it can be run on a schedule rather than remembered.
 */
export {};

const BASE = process.env.MONITOR_URL ?? 'http://localhost:3111';
const HOURS = Number(process.env.MONITOR_HOURS ?? 24);
// A deployed console is password-gated, so a monitor without the password only ever
// reports that it cannot see anything.
const PASSWORD = process.env.CONSOLE_PASSWORD ?? '';

type Slo = {
  name: string; value: number; limit: number; ok: boolean; note: string;
  insufficientData?: boolean;
};

const res = await fetch(`${BASE}/api/metrics?hours=${HOURS}`, {
  headers: PASSWORD ? { 'x-console-password': PASSWORD } : {},
});
if (res.status === 401) {
  console.error(`monitor: ${BASE} needs CONSOLE_PASSWORD in the environment`);
  process.exit(2);
}
if (!res.ok) {
  console.error(`monitor: ${BASE} returned ${res.status}`);
  process.exit(2);
}

const m = (await res.json()) as {
  windowHours: number;
  turnsIn: number;
  modelCalls: number;
  costCents: number;
  costPerTurnCents: number;
  latency: { p50: number; p95: number; max: number };
  rates: Record<string, number>;
  rails: { code: string; level: string; count: number; perHundredTurns: number }[];
  brands: { domain: string; turns: number; costCents: number }[];
  slos: Slo[];
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

console.log(`\n  Last ${m.windowHours}h — ${m.turnsIn} customer turns, ${m.modelCalls} model calls\n`);

console.log(`  ${dim('cost')}      ${m.costCents.toFixed(2)}¢ total, ${m.costPerTurnCents.toFixed(3)}¢ per turn`);
console.log(`  ${dim('latency')}   p50 ${m.latency.p50}ms · p95 ${m.latency.p95}ms · max ${m.latency.max}ms`);
console.log(
  `  ${dim('rates')}     escalated ${m.rates.escalation}% · blocked ${m.rates.blocked}% · recovered ${m.rates.recovered}% · capped ${m.rates.limited}%`,
);

if (m.brands.length) {
  console.log(`\n  ${dim('by brand')}`);
  for (const b of m.brands) {
    console.log(`    ${b.domain.padEnd(28)} ${String(b.turns).padStart(4)} turns  ${b.costCents.toFixed(2)}¢`);
  }
}

console.log(`\n  ${dim('rails fired')}`);
for (const r of m.rails) {
  const colour = r.level === 'block' ? red : r.level === 'warn' ? amber : green;
  console.log(
    `    ${colour(r.level.padEnd(5))} ${r.code.padEnd(28)} ${String(r.count).padStart(4)}  ${r.perHundredTurns}/100 turns`,
  );
}

console.log(`\n  ${dim('service levels')}`);
let breached = 0;
for (const s of m.slos) {
  if (!s.ok) breached++;
  const mark = s.insufficientData ? dim('n/a ') : s.ok ? green('ok  ') : red('BREACH');
  console.log(`    ${mark} ${s.name.padEnd(22)} ${String(s.value).padStart(8)}  limit ${s.limit}`);
  if (s.insufficientData) console.log(`         ${dim('too little traffic to judge this rate yet')}`);
  else if (!s.ok) console.log(`         ${dim(s.note)}`);
}

if (m.turnsIn === 0) {
  console.log(`\n  ${amber('no traffic in this window — nothing to judge')}\n`);
  process.exit(0);
}

console.log(
  breached ? `\n  ${red(`${breached} service level breached`)}\n` : `\n  ${green('all service levels within limits')}\n`,
);
process.exit(breached ? 1 : 0);
