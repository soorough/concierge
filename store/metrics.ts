import { getDb } from './db.js';

/**
 * Production health, derived from what every turn already records.
 *
 * The rails were built to stop bad answers reaching a customer. They double as telemetry:
 * a rail firing is a machine-readable statement that the model tried something it should
 * not have, so their rates are the closest thing to a live safety signal this has.
 *
 * What they are *not* is an accuracy measure. A turn where no rail fired is a turn nobody
 * objected to, which is not the same as a turn that was right.
 */
export type RailRate = { code: string; level: string; count: number; perHundredTurns: number };

export type Metrics = {
  windowHours: number;
  turnsIn: number;
  modelCalls: number;
  costCents: number;
  costPerTurnCents: number;
  latency: { p50: number; p95: number; max: number };
  rates: {
    /** Turns where the reply was replaced or a human was asked for. */
    escalation: number;
    /** Turns where a rail blocked something. */
    blocked: number;
    /** Turns where the model did not return usable JSON. */
    recovered: number;
    /** Turns refused by a cap before any model call. */
    limited: number;
  };
  rails: RailRate[];
  brands: { domain: string; turns: number; costCents: number }[];
};

const RECOVERY_CODES = ['OUTPUT_RECOVERED', 'MALFORMED_OUTPUT'];
const LIMIT_CODES = ['RATE_LIMITED', 'SPEND_CAP', 'MESSAGE_TOO_LONG', 'INGEST_CAP'];

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

export function getMetrics(windowHours = 24): Metrics {
  const db = getDb();
  const since = Date.now() - windowHours * 3600_000;

  const turnsIn = (
    db.prepare("select count(*) c from turn where direction='in' and created_at >= ?").get(since) as { c: number }
  ).c;

  const outbound = db
    .prepare(
      `select id, model, cost_cents, latency_ms from turn
       where direction='out' and created_at >= ?`,
    )
    .all(since) as { id: string; model: string | null; cost_cents: number | null; latency_ms: number | null }[];

  const modelCalls = outbound.filter((t) => t.model).length;
  const costCents = outbound.reduce((sum, t) => sum + (t.cost_cents ?? 0), 0);
  const latencies = outbound
    .map((t) => t.latency_ms ?? 0)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);

  const events = db
    .prepare(
      `select re.turn_id, re.code, re.level from rail_event re
       join turn t on t.id = re.turn_id where t.created_at >= ?`,
    )
    .all(since) as { turn_id: string; code: string; level: string }[];

  const byCode = new Map<string, { level: string; count: number }>();
  const turnsWith = (predicate: (code: string, level: string) => boolean) =>
    new Set(events.filter((e) => predicate(e.code, e.level)).map((e) => e.turn_id)).size;

  for (const e of events) {
    const entry = byCode.get(e.code) ?? { level: e.level, count: 0 };
    entry.count++;
    byCode.set(e.code, entry);
  }

  const rate = (n: number) => (turnsIn ? Number(((n / turnsIn) * 100).toFixed(1)) : 0);

  const brands = db
    .prepare(
      // Turns are counted inbound and cost is recorded outbound, so filtering to one
      // direction gives a table where every brand appears to be free.
      `select b.domain,
              sum(case when t.direction = 'in' then 1 else 0 end) turns,
              coalesce(sum(t.cost_cents), 0) cost
       from turn t join customer c on c.id = t.customer_id join brand b on b.id = c.brand_id
       where t.created_at >= ?
       group by b.domain order by turns desc`,
    )
    .all(since) as { domain: string; turns: number; cost: number }[];

  return {
    windowHours,
    turnsIn,
    modelCalls,
    costCents: Number(costCents.toFixed(3)),
    costPerTurnCents: modelCalls ? Number((costCents / modelCalls).toFixed(3)) : 0,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.at(-1) ?? 0,
    },
    rates: {
      escalation: rate(turnsWith((code) => code === 'ESCALATED')),
      blocked: rate(turnsWith((_, level) => level === 'block')),
      recovered: rate(turnsWith((code) => RECOVERY_CODES.includes(code))),
      limited: rate(turnsWith((code) => LIMIT_CODES.includes(code))),
    },
    rails: [...byCode.entries()]
      .map(([code, { level, count }]) => ({
        code,
        level,
        count,
        perHundredTurns: rate(count),
      }))
      .sort((a, b) => b.count - a.count),
    brands: brands.map((b) => ({
      domain: b.domain,
      turns: b.turns,
      costCents: Number(b.cost.toFixed(3)),
    })),
  };
}

/**
 * Starting thresholds, deliberately written down rather than left to judgement.
 *
 * Escalation has a floor as well as a ceiling: an agent that never escalates on a real
 * catalog is not being careful, it is being lucky or the rails have stopped firing.
 */
export type Slo = { name: string; value: number; limit: number; ok: boolean; note: string };

export function checkSlos(m: Metrics): Slo[] {
  const slo = (name: string, value: number, limit: number, note: string, floor = false): Slo => ({
    name,
    value,
    limit,
    ok: floor ? value >= limit : value <= limit,
    note,
  });

  return [
    slo('escalation rate %', m.rates.escalation, 25, 'above this the agent is refusing too much to be useful'),
    slo('blocked rate %', m.rates.blocked, 12, 'rails firing this often means the prompt or ingest is wrong'),
    slo('recovered output %', m.rates.recovered, 3, 'the model is not returning JSON reliably'),
    slo('p95 latency ms', m.latency.p95, 5000, 'a message thread that takes this long feels broken'),
    slo('cost per turn ¢', m.costPerTurnCents, 1.5, 'a conversation should cost less than the SMS blasts it replaces'),
  ];
}
