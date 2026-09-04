import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/*
 * Storefronts price in the viewer's market, and Node's fetch sends `accept-language: *` by
 * default, which Shopify reads as an invitation to geolocate. Ingesting a US brand from
 * India returned INR — $14.95 arriving as "1500.00".
 *
 * An empty Accept-Language suppresses that negotiation and returns the shop's own market.
 * Verified: empty gives USD on every attempt, while `*`, `en` and `en-US` all give INR.
 * The currency check at ingest stays regardless — this makes the right thing likely, and
 * validation makes the wrong thing impossible to store.
 */
const BASE_HEADERS: Record<string, string> = { 'User-Agent': UA, 'Accept-Language': '' };

/** RFC1918 + loopback + link-local + CGNAT + unique-local v6. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export class BlockedTargetError extends Error {}

/**
 * Ingest fetches arbitrary user-supplied URLs, so every hop is validated: HTTP(S) only,
 * no private address space, and redirects are followed manually so each new target is
 * re-checked rather than trusted.
 */
export async function safeFetch(
  url: string,
  opts: {
    timeoutMs?: number;
    maxRedirects?: number;
    accept?: string;
    /** Extra request headers. Used to pin a storefront to the brand's own market. */
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  } = {},
): Promise<{ res: Response; body: string; finalUrl: string }> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let target = url;

  for (let hop = 0; hop <= (opts.maxRedirects ?? 4); hop++) {
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BlockedTargetError(`refused scheme: ${parsed.protocol}`);
    }
    const host = parsed.hostname;
    if (isIP(host)) {
      if (isPrivateAddress(host)) throw new BlockedTargetError(`refused private address: ${host}`);
    } else {
      const { address } = await lookup(host);
      if (isPrivateAddress(address)) {
        throw new BlockedTargetError(`refused private address: ${host} -> ${address}`);
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(target, {
        redirect: 'manual',
        signal: ctrl.signal,
        method: opts.method ?? 'GET',
        ...(opts.body ? { body: opts.body } : {}),
        headers: { ...BASE_HEADERS, Accept: opts.accept ?? '*/*', ...(opts.headers ?? {}) },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { res, body: '', finalUrl: target };
      target = new URL(loc, target).toString();
      continue;
    }
    const body = await res.text();
    return { res, body, finalUrl: target };
  }
  throw new BlockedTargetError('too many redirects');
}

export function normaliseDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error(`not a valid domain: ${input}`);
  return d;
}
