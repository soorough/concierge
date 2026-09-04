import { useEffect, useState } from 'react';
import { api, clock, type Brand, type Fact, type Health, type Metrics, type ThreadTurn } from './api';

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
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Health is about the deployment, not this thread, so it refreshes on its own.
  useEffect(() => {
    let live = true;
    const load = () => {
      api.metrics(24).then((m) => live && setMetrics(m)).catch(() => undefined);
      api.health().then((h) => live && setHealth(h)).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [turns.length]);

  const events = turns.flatMap((t) => t.rails.map((r) => ({ ...r, at: t.created_at })));

  /*
   * Turns that called a tool, with what the turn cost beside what it did.
   *
   * A loop makes cost per turn variable, and the honest thing is to show the variance
   * rather than average it away — a turn that cost twice the usual should say what it
   * bought with the difference.
   */
  const trajectories = turns
    .filter((t) => t.tools && t.tools.length > 0)
    .map((t) => ({
      at: t.created_at,
      costCents: t.cost_cents,
      latencyMs: t.latency_ms,
      calls: [...t.tools].sort((a, b) => a.seq - b.seq),
    }));
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
        <span>Trajectory</span>
        <span>{trajectories.length} turn{trajectories.length === 1 ? '' : 's'} used tools</span>
      </p>
      {trajectories.length === 0 ? (
        <p className="empty">
          No turn has needed a tool yet. Most do not — a question the catalog already answers
          takes one model call.
        </p>
      ) : (
        trajectories.map((t, i) => (
          <div className="row" key={i}>
            <time>{clock(t.at)}</time>
            <span>
              {t.calls.map((c) => (
                <span key={c.seq}>
                  <span className="code">{c.tool}</span>
                  <span className="detail">
                    {' '}
                    {c.arguments_json} · {c.source}
                    {c.ok ? '' : ' · failed'} · {c.ms}ms
                  </span>
                  <br />
                </span>
              ))}
              <span className="detail">
                {t.calls.length} call{t.calls.length === 1 ? '' : 's'}
                {t.costCents === null ? '' : ` · ${t.costCents.toFixed(3)}¢`}
                {t.latencyMs === null ? '' : ` · ${t.latencyMs}ms`}
              </span>
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

      {health && !health.storage.persistent && (
        <>
          <p className="eyebrow"><span>Storage</span></p>
          <div className="row lvl-block">
            <time>warn</time>
            <span>
              <span className="code">NOT PERSISTENT</span>
              <span className="detail">
                {' '}
                {health.storage.reason}
              </span>
            </span>
          </div>
        </>
      )}

      {metrics && metrics.turnsIn > 0 && (
        <>
          <p className="eyebrow">
            <span>Health · last {metrics.windowHours}h</span>
            <span>{metrics.turnsIn} turns</span>
          </p>
          {metrics.slos.map((s) => (
            <div className={`row ${s.ok ? 'lvl-pass' : 'lvl-block'}`} key={s.name}>
              <time>{s.ok ? 'ok' : 'breach'}</time>
              <span>
                <span className="code">{s.name}</span>
                <span className="detail">
                  {' '}
                  {s.value} <span style={{ opacity: 0.6 }}>/ {s.limit}</span>
                </span>
              </span>
            </div>
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
