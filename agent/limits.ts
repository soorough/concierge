import { getDb } from '../store/db.js';

/**
 * Limits on the tool itself, not on what the agent says.
 *
 * The endpoints spend model credits and fetch arbitrary URLs, so a shared link needs a
 * ceiling that does not depend on anyone behaving well. Every refusal is recorded as a
 * rail event so a cap looks like every other guardrail in the console rather than an
 * unexplained silence.
 */
export const LIMITS = {
  /** Longest customer message accepted. Longer inputs are a token-burn vector. */
  maxMessageChars: Number(process.env.MAX_MESSAGE_CHARS ?? 2000),
  /** Turns one session may spend. */
  sessionTurnCap: Number(process.env.SESSION_TURN_CAP ?? 40),
  /** Ingests one session may run. */
  sessionIngestCap: Number(process.env.SESSION_INGEST_CAP ?? 5),
  /** Whole-tool spend ceiling per UTC day, in cents. */
  dailySpendCapCents: Number(process.env.DAILY_SPEND_CAP_CENTS ?? 500),
  /** Largest quantity a single cart line may hold. */
  maxLineQty: Number(process.env.MAX_LINE_QTY ?? 24),
};

export type LimitVerdict = { allowed: true } | { allowed: false; code: string; message: string };

const today = () => new Date().toISOString().slice(0, 10);

export function spendToday(): number {
  const row = getDb().prepare('select cost_cents from spend_log where day = ?').get(today()) as
    | { cost_cents: number }
    | undefined;
  return row?.cost_cents ?? 0;
}

export function recordSpend(cents: number): void {
  if (!(cents > 0)) return;
  getDb()
    .prepare(
      `insert into spend_log (day, cost_cents) values (?, ?)
       on conflict(day) do update set cost_cents = cost_cents + excluded.cost_cents`,
    )
    .run(today(), cents);
}

export function checkTurnAllowed(customerId: string, message: string): LimitVerdict {
  if (message.length > LIMITS.maxMessageChars) {
    return {
      allowed: false,
      code: 'MESSAGE_TOO_LONG',
      message: `That message is longer than I can read in one go — could you shorten it?`,
    };
  }

  const turns = (
    getDb()
      .prepare("select count(*) c from turn where customer_id = ? and direction = 'in'")
      .get(customerId) as { c: number }
  ).c;
  if (turns >= LIMITS.sessionTurnCap) {
    return {
      allowed: false,
      code: 'RATE_LIMITED',
      message: 'This demo conversation has reached its limit. Start a new thread to continue.',
    };
  }

  if (spendToday() >= LIMITS.dailySpendCapCents) {
    return {
      allowed: false,
      code: 'SPEND_CAP',
      message: "This demo has hit today's usage limit. Try again tomorrow.",
    };
  }

  return { allowed: true };
}

export function checkIngestAllowed(sessionId: string): LimitVerdict {
  const count = (
    getDb()
      .prepare('select count(*) c from brand where ingested_at > ?')
      .get(Date.now() - 24 * 60 * 60 * 1000) as { c: number }
  ).c;
  if (count >= LIMITS.sessionIngestCap * 20) {
    return { allowed: false, code: 'INGEST_CAP', message: 'Ingest limit reached for today.' };
  }
  if (spendToday() >= LIMITS.dailySpendCapCents) {
    return { allowed: false, code: 'SPEND_CAP', message: "Today's usage limit has been reached." };
  }
  void sessionId;
  return { allowed: true };
}
