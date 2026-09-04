export type Brand = {
  id: string; domain: string; name: string; category: string;
  ingest_path: string; detected_sms_vendor: string | null;
  logo_url: string | null; palette: string[]; missing: string[]; offers: string[];
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
  cartId: string;
  lines: CartLine[];
  subtotalCents: number;
  totalCents: number | null;
  discounts: { title: string; amountCents: number }[];
  currency: string;
  permalink: string | null;
  pricedBy: 'store' | 'catalog';
};

export type ToolCall = {
  seq: number; iteration: number; tool: string;
  arguments_json: string | null; result_json: string | null;
  source: string | null; ok: number; ms: number | null;
};

export type TurnResult = {
  turnId: string; customerId: string; reply: string | null;
  cart: Cart | null; showCheckout: boolean; needsAgeCheck: boolean;
  rails: RailEvent[]; latencyMs: number; costCents: number;
  model: string | null; provider: string | null;
  trace: { tool: string; args: Record<string, unknown>; source: string; ok: boolean; ms: number }[];
  modelCalls: number; route: string;
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
  tools: ToolCall[];
};

const PASSWORD_KEY = 'concierge.password';

export class UnauthorisedError extends Error {}

export const getPassword = (): string => {
  try {
    return localStorage.getItem(PASSWORD_KEY) ?? '';
  } catch {
    return '';
  }
};

export const setPassword = (value: string): void => {
  try {
    localStorage.setItem(PASSWORD_KEY, value);
  } catch {
    /* a viewer with storage blocked simply re-enters it */
  }
};

/**
 * The deployed API is gated by a shared password. Sending it on every request keeps the
 * console usable without a session endpoint; the header is the same one `gate.ts` checks.
 */
export const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const password = getPassword();
  return password ? { ...extra, 'x-console-password': password } : extra;
};

const json = async (r: Response) => {
  if (r.status === 401) throw new UnauthorisedError('This console needs its password.');
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? r.statusText);
  return r.json();
};

const get = (url: string) => fetch(url, { headers: authHeaders() }).then(json);

const del = (url: string) =>
  fetch(url, { method: 'DELETE', headers: authHeaders() }).then(json);

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }).then(json);

export type Slo = { name: string; value: number; limit: number; ok: boolean; note: string };

export type Metrics = {
  windowHours: number;
  turnsIn: number;
  modelCalls: number;
  costCents: number;
  costPerTurnCents: number;
  latency: { p50: number; p95: number; max: number };
  rates: { escalation: number; blocked: number; recovered: number; limited: number };
  rails: { code: string; level: string; count: number; perHundredTurns: number }[];
  slos: Slo[];
};

export type Health = {
  ok: boolean;
  storage: { path: string; persistent: boolean; reason: string };
};

export const api = {
  health: (): Promise<Health> => get('/api/health'),
  metrics: (hours = 24): Promise<Metrics> => get(`/api/metrics?hours=${hours}`),
  brands: (): Promise<{ id: string; domain: string; name: string; category: string }[]> =>
    get('/api/brands'),
  brand: (domain: string): Promise<Brand> => get(`/api/brand/${encodeURIComponent(domain)}`),
  deleteBrand: (domain: string): Promise<{ deleted: string }> =>
    del(`/api/brand/${encodeURIComponent(domain)}`),
  preflight: (domain: string) => post('/api/preflight', { domain }),
  turn: (brandId: string, sessionId: string, text: string): Promise<TurnResult> =>
    post('/api/turn', { brandId, sessionId, text }),
  thread: (brandId: string, sessionId: string): Promise<{ turns: ThreadTurn[] }> =>
    get(`/api/thread?brandId=${brandId}&sessionId=${sessionId}`),
  facts: (brandId: string, sessionId: string): Promise<{ current: Fact[]; all: Fact[] }> =>
    get(`/api/facts?brandId=${brandId}&sessionId=${sessionId}`),
  cart: (brandId: string, sessionId: string): Promise<Cart> =>
    get(`/api/cart?brandId=${brandId}&sessionId=${sessionId}`),
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
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ domain, force }),
  });
  if (res.status === 401) throw new UnauthorisedError('This console needs its password.');
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
