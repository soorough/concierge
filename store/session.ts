import { getDb, id } from './db.js';

export type Customer = {
  id: string; brand_id: string; session_id: string;
  display_name: string | null; locale: string | null; region: string | null;
  age_verified_at: number | null; opted_out_at: number | null; first_seen: number;
};

/**
 * A deployed link means several people use the tool at once, so a thread is scoped to
 * (brand, session). Without this two visitors would share one customer row and one fact
 * ledger, and see each other's messages.
 */
export function getOrCreateCustomer(brandId: string, sessionId: string): Customer {
  const db = getDb();
  const found = db
    .prepare('select * from customer where brand_id = ? and session_id = ?')
    .get(brandId, sessionId) as Customer | undefined;
  if (found) return found;

  const customerId = id('cust');
  db.prepare(
    `insert into customer (id, brand_id, session_id, first_seen) values (?,?,?,?)`,
  ).run(customerId, brandId, sessionId, Date.now());
  return db.prepare('select * from customer where id = ?').get(customerId) as Customer;
}

export type TurnRow = {
  id: string; customer_id: string; direction: 'in' | 'out';
  text: string | null; payload_json: string | null;
  model: string | null; provider: string | null;
  input_tokens: number | null; output_tokens: number | null;
  cost_cents: number | null; latency_ms: number | null; created_at: number;
};

export function recordTurn(t: {
  customerId: string; direction: 'in' | 'out'; text?: string | null;
  payload?: unknown; model?: string | null; provider?: string | null;
  inputTokens?: number | null; outputTokens?: number | null;
  costCents?: number | null; latencyMs?: number | null;
}): string {
  const turnId = id('turn');
  getDb().prepare(`
    insert into turn (id, customer_id, direction, text, payload_json, model, provider,
                      input_tokens, output_tokens, cost_cents, latency_ms, created_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    turnId, t.customerId, t.direction, t.text ?? null,
    t.payload ? JSON.stringify(t.payload) : null,
    t.model ?? null, t.provider ?? null,
    t.inputTokens ?? null, t.outputTokens ?? null,
    t.costCents ?? null, t.latencyMs ?? null, Date.now(),
  );
  return turnId;
}

export function recentTurns(customerId: string, limit = 8): TurnRow[] {
  return getDb()
    .prepare('select * from turn where customer_id = ? order by created_at desc limit ?')
    .all(customerId, limit)
    .reverse() as TurnRow[];
}

export function recordRailEvent(turnId: string, level: 'pass' | 'warn' | 'block', code: string, detail?: string) {
  getDb()
    .prepare('insert into rail_event (id, turn_id, level, code, detail) values (?,?,?,?,?)')
    .run(id('rail'), turnId, level, code, detail ?? null);
}

export type ToolCallRow = {
  id: string;
  turn_id: string;
  seq: number;
  iteration: number;
  tool: string;
  arguments_json: string | null;
  result_json: string | null;
  source: string | null;
  ok: number;
  ms: number | null;
  created_at: number;
};

/**
 * One step of a turn's trajectory.
 *
 * Written even when the tool failed, and even when the budget then ran out. A trace that
 * only records what worked cannot answer the question Step 5 exists to ask, which is
 * whether the agent went about it the right way.
 */
export function recordToolCall(row: {
  turnId: string;
  seq: number;
  iteration: number;
  tool: string;
  args: unknown;
  result: string;
  source: string;
  ok: boolean;
  ms: number;
}) {
  getDb()
    .prepare(
      `insert into tool_call
       (id, turn_id, seq, iteration, tool, arguments_json, result_json, source, ok, ms, created_at)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id('tool'),
      row.turnId,
      row.seq,
      row.iteration,
      row.tool,
      JSON.stringify(row.args ?? {}),
      row.result.slice(0, 2000),
      row.source,
      row.ok ? 1 : 0,
      row.ms,
      Date.now(),
    );
}

export function toolCallsFor(turnIds: string[]): ToolCallRow[] {
  if (!turnIds.length) return [];
  const q = `select * from tool_call where turn_id in (${turnIds.map(() => '?').join(',')}) order by seq`;
  return getDb().prepare(q).all(...turnIds) as ToolCallRow[];
}

export function railEventsFor(turnIds: string[]) {
  if (!turnIds.length) return [];
  const q = `select * from rail_event where turn_id in (${turnIds.map(() => '?').join(',')})`;
  return getDb().prepare(q).all(...turnIds) as {
    id: string; turn_id: string; level: string; code: string; detail: string | null;
  }[];
}
