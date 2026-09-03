import { useState } from 'react';
import { api, clock, type Brand, type Fact, type ThreadTurn } from './api';

/**
 * The operator's side: what the machine did, and why it is allowed to have said it.
 * Rail events read as a log; the ledger keeps superseded facts visible rather than
 * deleting them, because that is the whole argument for an append-only profile.
 */
export function Record({
  brand, sessionId, turns, facts, onFacts,
}: {
  brand: Brand;
  sessionId: string;
  turns: ThreadTurn[];
  facts: { current: Fact[]; all: Fact[] };
  onFacts: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const events = turns.flatMap((t) => t.rails.map((r) => ({ ...r, at: t.created_at })));
  const superseded = facts.all.filter((f) => f.valid_to !== null);

  const submitNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setNoteError(null);
    try {
      await api.fieldNote(brand.id, sessionId, note);
      setNote('');
      onFacts();
    } catch (e) {
      setNoteError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col">
      <p className="eyebrow">
        <span>Rails</span>
        <span>{events.length}</span>
      </p>
      {events.length === 0 ? (
        <p className="empty">No rails have fired yet. Send a message.</p>
      ) : (
        events.map((e, i) => (
          <div className={`row lvl-${e.level}`} key={i}>
            <time>{clock(e.at)}</time>
            <span>
              <span className="code">{e.code}</span>
              {e.detail && <span className="detail"> · {e.detail}</span>}
            </span>
          </div>
        ))
      )}

      <p className="eyebrow">
        <span>Fact ledger</span>
        <span>{facts.current.length} current · {superseded.length} closed</span>
      </p>
      {facts.all.length === 0 ? (
        <p className="empty">Nothing learned yet. Facts appear as the customer reveals them.</p>
      ) : (
        <>
          {facts.current.map((f) => (
            <FactRow key={f.id} fact={f} />
          ))}
          {superseded.map((f) => (
            <FactRow key={f.id} fact={f} dead />
          ))}
        </>
      )}

      <p className="eyebrow"><span>Add a rep's note</span></p>
      <div className="note">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`What a rep knows about this customer — how they shop ${brand.name}, their budget, the occasion, anything they mentioned in person.`}
          aria-label="Rep's note about this customer"
        />
        <button onClick={submitNote} disabled={busy || !note.trim()}>
          {busy ? 'Reading note' : 'Add to ledger'}
        </button>
        {noteError && <p className="empty" style={{ color: 'var(--block)' }}>{noteError}</p>}
      </div>
    </div>
  );
}

function FactRow({ fact, dead }: { fact: Fact; dead?: boolean }) {
  return (
    <div className={`fact${dead ? ' fact--dead' : ''}`}>
      <span className="fact__pred">{fact.predicate}</span>
      <span className="fact__obj">{fact.object}</span>
      <span className="fact__meta">
        <span className={`src src--${fact.source}`}>{fact.source.replace('_', ' ')}</span>
        <br />
        {fact.confidence !== null ? `${fact.confidence.toFixed(2)} · ` : ''}
        {dead ? `closed ${clock(fact.valid_to!)}` : clock(fact.valid_from)}
      </span>
    </div>
  );
}
