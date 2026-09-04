import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  sessionId as getSessionId,
  getPassword,
  setPassword,
  UnauthorisedError,
  type Brand,
  type Cart,
  type Fact,
  type ThreadTurn,
} from './api';
import { Phone } from './Phone';
import { Ingest } from './Ingest';
import { Record } from './Record';

const sessionId = getSessionId();

/** Readable text over an arbitrary brand colour, so ingested palettes stay legible. */
function contrastInk(hex: string): string {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
}

export function App() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [brands, setBrands] = useState<{ domain: string; name: string }[]>([]);
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [facts, setFacts] = useState<{ current: Fact[]; all: Fact[] }>({ current: [], all: [] });
  const [cart, setCart] = useState<Cart | null>(null);
  const [showCheckout, setShowCheckout] = useState(false);
  const [needsAge, setNeedsAge] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const loadBrand = useCallback(async (domain: string) => {
    const b = await api.brand(domain);
    setBrand(b);
    const [t, f, c] = await Promise.all([
      api.thread(b.id, sessionId),
      api.facts(b.id, sessionId),
      api.cart(b.id, sessionId),
    ]);
    setTurns(t.turns);
    setFacts(f);
    setCart(c.lines.length ? c : null);
    // The cart is real, so the card it belongs to should survive a reload rather than
    // living only in the memory of the tab that created it.
    const lastOut = [...t.turns].reverse().find((x) => x.direction === 'out');
    setShowCheckout(lastOut?.payload?.card === 'checkout' && c.lines.length > 0);
  }, []);

  const refreshBrands = useCallback(async () => {
    try {
      setBrands(await api.brands());
    } catch {
      /* the list is a convenience; ingest still works without it */
    }
  }, []);

  useEffect(() => {
    api.brands()
      .then((list) => {
        setLocked(false);
        setBrands(list);
        return list.length ? loadBrand(list[0].domain) : undefined;
      })
      .catch((e) => {
        // A deployed console is password-gated; an unlocked one simply never sees this.
        if (e instanceof UnauthorisedError) setLocked(true);
      });
  }, [loadBrand]);

  useEffect(() => {
    if (!brand?.palette?.length) return;
    const accent = brand.palette[0];
    document.documentElement.style.setProperty('--brand', accent);
    document.documentElement.style.setProperty('--brand-ink', contrastInk(accent));
  }, [brand?.palette]);

  const refreshFacts = useCallback(async () => {
    if (!brand) return;
    setFacts(await api.facts(brand.id, sessionId));
  }, [brand]);

  const send = async (text: string) => {
    if (!brand) return;
    setPending(true);
    setError(null);
    setTurns((t) => [
      ...t,
      { id: `local_${Date.now()}`, direction: 'in', text, payload: null, created_at: Date.now(), latency_ms: null, cost_cents: null, rails: [] },
    ]);
    try {
      const r = await api.turn(brand.id, sessionId, text);
      setShowCheckout(r.showCheckout);
      setNeedsAge(r.needsAgeCheck);
      setCart(r.cart);
      const [t, f] = await Promise.all([api.thread(brand.id, sessionId), api.facts(brand.id, sessionId)]);
      setTurns(t.turns);
      setFacts(f);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const confirmAge = async (confirmed: boolean) => {
    if (!brand) return;
    await api.confirmAge(brand.id, sessionId, confirmed);
    setNeedsAge(false);
    if (confirmed) await send("Yes, I'm 21 or older.");
  };

  const totals = useMemo(() => {
    const out = turns.filter((t) => t.direction === 'out' && t.latency_ms !== null);
    const cost = turns.reduce((n, t) => n + (t.cost_cents ?? 0), 0);
    const lat = out.map((t) => t.latency_ms!).sort((a, b) => a - b);
    return {
      turns: turns.filter((t) => t.direction === 'in').length,
      cost,
      p50: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
    };
  }, [turns]);

  if (locked) return <Lock onUnlocked={() => window.location.reload()} />;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="wordmark">Concierge</span>
        {brands.length > 0 && (
          <label className="stat">
            <span>brand</span>
            {/* Once more than one brand is ingested, retyping the domain to switch is
                friction with no purpose — every ingested brand is already in the DB. */}
            <select
              className="brandpick"
              value={brand?.domain ?? ''}
              onChange={(e) => loadBrand(e.target.value)}
              aria-label="Brand"
            >
              {brands.map((b) => (
                <option key={b.domain} value={b.domain}>
                  {b.domain}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="spacer" />
        <span className="stat"><span>turns</span><b>{totals.turns}</b></span>
        <span className="stat"><span>cost</span><b>{totals.cost.toFixed(2)}¢</b></span>
        <span className="stat"><span>p50</span><b>{totals.p50}ms</b></span>
        {brand && <span className="stat"><span>catalog</span><b>{brand.counts.sellable}</b></span>}
      </header>

      <div className="columns">
        <Ingest
          brand={brand}
          onIngested={async (domain) => {
            await loadBrand(domain);
            await refreshBrands();
          }}
          onRemoved={async () => {
            // Fall through to whatever is left, or an empty console if nothing is.
            const remaining = await api.brands().catch(() => []);
            setBrands(remaining);
            setBrand(null);
            setTurns([]);
            setFacts({ current: [], all: [] });
            setCart(null);
            setShowCheckout(false);
            if (remaining.length) await loadBrand(remaining[0].domain);
          }}
        />

        <div className="col col--stage">
          {brand ? (
            <>
              <Phone
                brand={brand}
                sessionId={sessionId}
                turns={turns}
                cart={cart}
                showCheckout={showCheckout}
                needsAge={needsAge}
                pending={pending}
                onSend={send}
                onAge={confirmAge}
                onCartChange={(c) => setCart(c.lines.length ? c : null)}
              />
              <p className="stage__note">
                Simulator · messages deliver whole, as a real thread would
              </p>
              {error && <p className="stage__note" style={{ color: 'var(--block)' }}>{error}</p>}
            </>
          ) : (
            <p className="empty">Read a brand's site to start a thread.</p>
          )}
        </div>

        {brand ? (
          <Record brand={brand} sessionId={sessionId} turns={turns} facts={facts} onFacts={refreshFacts} />
        ) : (
          <div className="col">
            <p className="eyebrow"><span>Record</span></p>
            <p className="empty">Rails and the fact ledger appear once a thread starts.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The whole console is behind one shared password, so the gate is one field rather than a
 * sign-in flow. Deliberately says what it is: an internal tool, not a product login.
 */
function Lock({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState(getPassword());

  return (
    <div className="lock">
      <form
        className="lock__box"
        onSubmit={(e) => {
          e.preventDefault();
          setPassword(value.trim());
          onUnlocked();
        }}
      >
        <p className="eyebrow"><span>Concierge</span></p>
        <p className="empty">
          This console is shared with the team and spends model credits, so it is behind a
          password.
        </p>
        <div className="field">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Console password"
            aria-label="Console password"
            autoFocus
          />
          <button type="submit">Unlock</button>
        </div>
      </form>
    </div>
  );
}
