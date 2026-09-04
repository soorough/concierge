import { useEffect, useState } from 'react';
import { api, ingestStream, type Brand } from './api';

type LogLine = { k: string; v: string; cls?: string };

export function Ingest({
  brand,
  onIngested,
  onRemoved,
}: {
  brand: Brand | null;
  onIngested: (domain: string) => void;
  onRemoved: () => void;
}) {
  const [domain, setDomain] = useState(brand?.domain ?? 'onehopewine.com');
  const [verdict, setVerdict] = useState<{ path: string; detail: string; ms: number } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  // Removing a brand deletes its threads, facts and carts too, so it asks once rather than
  // relying on a browser dialog.
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Follow the selected brand, so the field never contradicts the thread beside it.
  useEffect(() => {
    if (brand?.domain) setDomain(brand.domain);
    setConfirmRemove(false);
  }, [brand?.domain]);

  const remove = async () => {
    if (!brand) return;
    setBusy(true);
    try {
      await api.deleteBrand(brand.domain);
      setConfirmRemove(false);
      setVerdict(null);
      setLog([]);
      onRemoved();
    } catch (e) {
      setLog([{ k: 'error', v: (e as Error).message, cls: 'errline' }]);
    } finally {
      setBusy(false);
    }
  };

  const run = async (force: boolean) => {
    setBusy(true);
    setLog([]);
    setVerdict(null);
    try {
      const pre = (await api.preflight(domain)) as {
        path: string;
        detail: string;
        ms: number;
        domain: string;
      };
      setVerdict(pre);
      if (pre.domain) setDomain(pre.domain);
      if (pre.path === 'blocked') {
        setLog([{ k: 'stopped', v: 'ingest needs their cooperation or an API key', cls: 'errline' }]);
        return;
      }
      await ingestStream(domain, force, (e) => {
        if (e.type === 'stage') setLog((l) => [...l, { k: String(e.stage), v: String(e.detail ?? '') }]);
        else if (e.type === 'count') setLog((l) => [...l, { k: String(e.label), v: String(e.value) }]);
        else if (e.type === 'warn') setLog((l) => [...l, { k: 'missing', v: String(e.message).replace(/^not found: /, ''), cls: 'warnline' }]);
        else if (e.type === 'error') setLog((l) => [...l, { k: 'error', v: String(e.message), cls: 'errline' }]);
        // The server normalises what was typed — "https://brand.com/" becomes "brand.com".
        // Handing back the raw input produced /api/brand/https://brand.com/, which 404s and
        // left the console with no brand and no thread after a successful ingest.
        else if (e.type === 'result') {
          const ingested = (e.result as { domain?: string } | undefined)?.domain ?? domain;
          setDomain(ingested);
          onIngested(ingested);
        }
      });
    } catch (err) {
      setLog((l) => [...l, { k: 'error', v: (err as Error).message, cls: 'errline' }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col">
      <p className="eyebrow"><span>Ingest</span></p>

      <form className="field" onSubmit={(e) => { e.preventDefault(); run(false); }}>
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="brand domain"
          aria-label="Brand domain"
          spellCheck={false}
        />
        <button type="submit" disabled={busy}>{busy ? 'Reading' : 'Read site'}</button>
      </form>

      {verdict && (
        <div className={`verdict ${verdict.path}`}>
          <b>{verdict.path} · {verdict.ms}ms</b>
          {verdict.detail}
        </div>
      )}

      {log.length > 0 && (
        <div className="log">
          {log.map((l, i) => (
            <div key={i} className={l.cls}>
              <span className="k">{l.k}</span>
              <span>{l.v}</span>
            </div>
          ))}
        </div>
      )}

      {brand && (
        <>
          <div className="figures">
            <div className="figure"><b>{brand.counts.sellable}</b><span>sellable</span></div>
            <div className="figure"><b>{brand.counts.total - brand.counts.sellable}</b><span>excluded</span></div>
            <div className="figure"><b>{brand.counts.policies}</b><span>policy chunks</span></div>
          </div>

          <p className="eyebrow"><span>What the site told us</span></p>
          <div className="row"><time>brand</time><span className="detail">{brand.name}</span></div>
          <div className="row"><time>category</time><span className="detail">{brand.category}</span></div>
          <div className="row">
            <time>sms</time>
            <span className="detail">{brand.detected_sms_vendor ?? 'none detected'}</span>
          </div>
          <div className="row">
            <time>palette</time>
            <span className="detail">
              <span className="swatches">
                {brand.palette.slice(0, 5).map((c) => (
                  <span key={c} className="swatch" style={{ background: c }} title={c} />
                ))}
              </span>
            </span>
          </div>
          <div className="row">
            <time>ingested</time>
            <span className="detail">{new Date(brand.ingested_at).toLocaleString()}</span>
          </div>

          <p className="eyebrow">
            <span>Not found</span>
            <span>{brand.missing.length}</span>
          </p>
          {brand.missing.length === 0 ? (
            <p className="empty">Everything we look for was present.</p>
          ) : (
            brand.missing.map((m, i) => (
              <div className="row lvl-warn" key={i}>
                <time>gap</time>
                <span className="detail">{m}</span>
              </div>
            ))
          )}

          <p className="eyebrow"><span>Remove</span></p>
          <div className="remove">
            {confirmRemove ? (
              <>
                <span className="remove__ask">
                  Delete {brand.name} and every thread, fact and cart under it?
                </span>
                <button className="remove__go" onClick={remove} disabled={busy}>
                  {busy ? 'Removing' : 'Delete'}
                </button>
                <button onClick={() => setConfirmRemove(false)} disabled={busy}>
                  Keep
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmRemove(true)}>Remove {brand.domain}</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
