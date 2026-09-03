export type Brand = {
  id: string; domain: string; name: string; category: string;
  ingest_path: string; detected_sms_vendor: string | null;
  logo_url: string | null; palette: string[]; missing: string[];
  restrictedRegions: string[]; free_ship_threshold: number | null;
  ingested_at: number;
  counts: { sellable: number; total: number; policies: number };
};

export type RailEvent = { level: 'pass' | 'warn' | 'block'; code: string; detail?: string };

export type CartLine = {
  product_id: string; variant_id: string | null; qty: number;
  title: string; price_cents: number; image_url: string | null; url: string;
};

export type Cart = {
  cartId: string; lines: CartLine[]; subtotalCents: number;
  currency: string; permalink: string | null;
};

export type TurnResult = {
  turnId: string; customerId: string; reply: string | null;
  cart: Cart | null; showCheckout: boolean; needsAgeCheck: boolean;
  rails: RailEvent[]; latencyMs: number; costCents: number;
  model: string | null; provider: string | null;
};

export type Fact = {
  id: string; predicate: string; object: string; confidence: number | null;
  source: string; valid_from: number; valid_to: number | null; superseded_by: string | null;
};

export type ThreadTurn = {
  id: string; direction: 'in' | 'out'; text: string | null;
  payload: { card?: string } | null; created_at: number;
  latency_ms: number | null; cost_cents: number | null;
  rails: { level: string; code: string; detail: string | null }[];
};

const json = async (r: Response) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? r.statusText);
  return r.json();
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);

export const api = {
  brands: (): Promise<{ id: string; domain: string; name: string }[]> => fetch('/api/brands').then(json),
  brand: (domain: string): Promise<Brand> => fetch(`/api/brand/${domain}`).then(json),
  preflight: (domain: string) => post('/api/preflight', { domain }),
  turn: (brandId: string, sessionId: string, text: string): Promise<TurnResult> =>
    post('/api/turn', { brandId, sessionId, text }),
  thread: (brandId: string, sessionId: string): Promise<{ turns: ThreadTurn[] }> =>
    fetch(`/api/thread?brandId=${brandId}&sessionId=${sessionId}`).then(json),
  facts: (brandId: string, sessionId: string): Promise<{ current: Fact[]; all: Fact[] }> =>
    fetch(`/api/facts?brandId=${brandId}&sessionId=${sessionId}`).then(json),
  cart: (brandId: string, sessionId: string): Promise<Cart> =>
    fetch(`/api/cart?brandId=${brandId}&sessionId=${sessionId}`).then(json),
  setQty: (brandId: string, sessionId: string, productId: string, qty: number): Promise<Cart> =>
    post('/api/cart/qty', { brandId, sessionId, productId, qty }),
  clearCart: (brandId: string, sessionId: string): Promise<Cart> =>
    post('/api/cart/clear', { brandId, sessionId }),
  confirmAge: (brandId: string, sessionId: string, confirmed: boolean) =>
    post('/api/age', { brandId, sessionId, confirmed }),
  fieldNote: (brandId: string, sessionId: string, note: string) =>
    post('/api/fieldnote', { brandId, sessionId, note }),
};

/** Ingest streams so the console shows real committed progress, not an animated bar. */
export async function ingestStream(
  domain: string,
  force: boolean,
  onEvent: (e: Record<string, unknown>) => void,
): Promise<void> {
  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain, force }),
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no stream');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim();
      if (line) onEvent(JSON.parse(line));
    }
  }
}

export function sessionId(): string {
  // ?session=… makes a thread linkable, which is how you hand someone the exact
  // conversation you are talking about rather than describing it.
  const fromUrl = new URLSearchParams(location.search).get('session');
  if (fromUrl) return fromUrl;

  const key = 'concierge.session';
  let v = localStorage.getItem(key);
  if (!v) {
    v = `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem(key, v);
  }
  return v;
}

export const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
