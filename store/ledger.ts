import { getDb, id } from './db.js';

export type Fact = {
  id: string; customer_id: string; predicate: string; object: string;
  confidence: number | null; source: string; source_turn_id: string | null;
  valid_from: number; valid_to: number | null; superseded_by: string | null;
};

export type FactSource = 'conversation' | 'field_note';

/** First-party (the customer said it) outranks third-party (a rep wrote it). */
const PRECEDENCE: Record<FactSource, number> = { conversation: 2, field_note: 1 };

export function currentFacts(customerId: string): Fact[] {
  return getDb()
    .prepare(
      `select * from fact where customer_id = ? and valid_to is null
       order by confidence desc, valid_from desc`,
    )
    .all(customerId) as Fact[];
}

export function allFacts(customerId: string): Fact[] {
  return getDb()
    .prepare('select * from fact where customer_id = ? order by valid_from desc')
    .all(customerId) as Fact[];
}

export type FactWrite = {
  customerId: string;
  predicate: string;
  object: string;
  confidence?: number;
  source: FactSource;
  sourceTurnId?: string | null;
};

export type FactWriteResult =
  | { action: 'inserted'; factId: string }
  | { action: 'superseded'; factId: string; supersededId: string }
  | { action: 'ignored'; reason: string; existingId: string };

/**
 * Facts are never mutated. A new fact closes the one it replaces by setting `valid_to`
 * and `superseded_by`; reads filter `valid_to IS NULL`.
 *
 * Arbitration when two sources disagree: first-party supersedes third-party regardless
 * of which arrived first; between two facts of the same provenance, newest wins. A
 * third-party fact never overwrites a first-party one — it is recorded but not promoted,
 * because personalisation that is confidently wrong is worse than none.
 */
export function writeFact(w: FactWrite): FactWriteResult {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .prepare(
      `select * from fact where customer_id = ? and predicate = ? and valid_to is null
       order by valid_from desc limit 1`,
    )
    .get(w.customerId, w.predicate) as Fact | undefined;

  if (existing) {
    if (existing.object.trim().toLowerCase() === w.object.trim().toLowerCase()) {
      return { action: 'ignored', reason: 'identical to current fact', existingId: existing.id };
    }
    const incoming = PRECEDENCE[w.source] ?? 0;
    const held = PRECEDENCE[(existing.source as FactSource) ?? 'field_note'] ?? 0;
    if (incoming < held) {
      // Recorded for the audit trail, but closed immediately: it never becomes current.
      const factId = id('fact');
      db.prepare(
        `insert into fact (id, customer_id, predicate, object, confidence, source,
                           source_turn_id, valid_from, valid_to, superseded_by)
         values (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        factId, w.customerId, w.predicate, w.object, w.confidence ?? null, w.source,
        w.sourceTurnId ?? null, now, now, existing.id,
      );
      return { action: 'ignored', reason: `outranked by ${existing.source}`, existingId: existing.id };
    }
  }

  const factId = id('fact');
  const tx = db.transaction(() => {
    db.prepare(
      `insert into fact (id, customer_id, predicate, object, confidence, source,
                         source_turn_id, valid_from, valid_to, superseded_by)
       values (?,?,?,?,?,?,?,?,null,null)`,
    ).run(
      factId, w.customerId, w.predicate, w.object, w.confidence ?? null, w.source,
      w.sourceTurnId ?? null, now,
    );
    if (existing) {
      db.prepare('update fact set valid_to = ?, superseded_by = ? where id = ?')
        .run(now, factId, existing.id);
    }
  });
  tx();

  return existing
    ? { action: 'superseded', factId, supersededId: existing.id }
    : { action: 'inserted', factId };
}
