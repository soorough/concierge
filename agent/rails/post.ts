import type { RetrievedProduct } from '../retrieve.js';
import type { RailEvent } from './types.js';

export type ModelOutput = {
  reply: string;
  actions: { type: string; sku?: string; qty?: number }[];
  learned: { predicate: string; object: string; confidence?: number }[];
  needs_age_check?: boolean;
  escalate?: string | null;
};

export type PostRailContext = {
  catalog: RetrievedProduct[];
  allSellableSkus: Set<string>;
  nonSellableSkus: Set<string>;
  category: string;
  ageVerified: boolean;
  restrictedRegions: string[];
  customerRegion: string | null;
};

export type PostRailResult = {
  reply: string;
  actions: ModelOutput['actions'];
  events: RailEvent[];
  /** True when the reply must not be sent as-is and a human is needed. */
  escalated: boolean;
  blockCheckout: boolean;
  needsAgeCheck: boolean;
};

const ESCALATION_REPLY =
  "I don't want to guess on that one — let me get someone from the team to confirm.";

/** Digits, and the spelled-out forms the numeric rail cannot see. */
const SPELLED_PRICE =
  /\b(?:around|about|roughly|approximately|circa|just under|just over|nearly)?\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)[\w\s-]{0,12}\s*(?:dollars|bucks|usd)\b/i;
const NUMERIC_PRICE = /\$\s?\d[\d,]*(?:\.\d{2})?/;
const OFFER =
  /(\d{1,2}\s?%\s?off|percent off|coupon|promo\s?code|discount code|voucher|free\s+(?:bottle|item|gift)\b)/i;

export function runPostRails(out: ModelOutput, ctx: PostRailContext): PostRailResult {
  const events: RailEvent[] = [];
  let reply = out.reply ?? '';
  let actions = out.actions ?? [];
  let escalated = false;
  let blockCheckout = false;

  // 1. Price resolution — the model emits a token, the database supplies the number.
  const priceBySku = new Map(ctx.catalog.map((p) => [(p.sku || p.id).toLowerCase(), p]));
  let resolved = 0;
  const unknownTokens: string[] = [];
  reply = reply.replace(/\{\{price:([^}]+)\}\}/g, (_m, rawSku: string) => {
    const p = priceBySku.get(rawSku.trim().toLowerCase());
    if (!p) {
      unknownTokens.push(rawSku.trim());
      return '';
    }
    resolved++;
    return `$${(p.price_cents / 100).toFixed(2)}`;
  });
  if (resolved) {
    events.push({ level: 'pass', code: 'PRICE_RESOLVED', detail: `${resolved} token(s) from DB` });
  }
  if (unknownTokens.length) {
    escalated = true;
    events.push({
      level: 'block',
      code: 'UNGROUNDED_PRICE',
      detail: `price token for unknown SKU: ${unknownTokens.join(', ')}`,
    });
  }

  // 2. Any price the model wrote itself is ungrounded by definition.
  const numeric = reply.match(NUMERIC_PRICE);
  if (numeric && resolved === 0) {
    escalated = true;
    events.push({ level: 'block', code: 'UNGROUNDED_PRICE', detail: `model wrote ${numeric[0]} directly` });
  } else if (SPELLED_PRICE.test(reply)) {
    escalated = true;
    events.push({
      level: 'block',
      code: 'UNGROUNDED_PRICE',
      detail: `price approximated in words: "${reply.match(SPELLED_PRICE)?.[0]?.trim()}"`,
    });
  }

  // 3. Offers. Only what is on-site is authorised.
  const offer = reply.match(OFFER);
  if (offer) {
    events.push({ level: 'block', code: 'UNAUTHORIZED_OFFER', detail: `matched "${offer[0]}"` });
    reply =
      "I can't put together a discount, but I'm happy to help you find something that fits what you're after.";
    actions = actions.filter((a) => a.type !== 'show_checkout');
  }

  // 4. Products the model named must exist and be sellable.
  for (const a of actions) {
    if (!a.sku) continue;
    const key = a.sku.toLowerCase();
    if (ctx.nonSellableSkus.has(key)) {
      escalated = true;
      events.push({ level: 'block', code: 'NON_SELLABLE_SKU', detail: `${a.sku} is not a sellable product` });
    } else if (!ctx.allSellableSkus.has(key)) {
      escalated = true;
      events.push({ level: 'block', code: 'CART_REJECTED', detail: `unknown SKU: ${a.sku}` });
    } else if (a.type === 'add_to_cart') {
      events.push({ level: 'pass', code: 'CART_WRITE', detail: `${a.sku} x${a.qty ?? 1}` });
    }
  }
  if (escalated) actions = actions.filter((a) => !a.sku);

  // 5. Age. On an alcohol brand the checkout card is withheld until confirmation.
  const needsAgeCheck =
    ctx.category === 'alcohol' && !ctx.ageVerified &&
    (Boolean(out.needs_age_check) || actions.some((a) => a.type === 'show_checkout' || a.type === 'add_to_cart'));
  if (needsAgeCheck) {
    blockCheckout = true;
    events.push({ level: 'block', code: 'AGE_REQUIRED', detail: 'alcohol brand, age not confirmed' });
  }

  // 6. Region.
  if (
    ctx.customerRegion &&
    ctx.restrictedRegions.some((r) => r.toLowerCase() === ctx.customerRegion!.toLowerCase())
  ) {
    blockCheckout = true;
    events.push({ level: 'block', code: 'REGION_BLOCKED', detail: `cannot ship to ${ctx.customerRegion}` });
  }

  // 7. Escalation, either the model's own or a rail's.
  if (out.escalate) {
    escalated = true;
    events.push({ level: 'warn', code: 'ESCALATED', detail: out.escalate });
  }
  if (escalated) {
    reply = ESCALATION_REPLY;
    actions = actions.filter((a) => a.type !== 'show_checkout');
  }

  // 8. Length.
  if (reply.length > 1000) {
    const cut = reply.slice(0, 1000);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    reply = (lastStop > 200 ? cut.slice(0, lastStop + 1) : cut).trim();
    events.push({ level: 'warn', code: 'LENGTH', detail: 'truncated at sentence boundary' });
  }

  return { reply: reply.replace(/\s{2,}/g, ' ').trim(), actions, events, escalated, blockCheckout, needsAgeCheck };
}

/** Models wrap JSON in prose or fences often enough that this must be tolerant. */
export function parseModelOutput(text: string): ModelOutput {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON object in model output: ${text.slice(0, 160)}`);
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<ModelOutput>;
  return {
    reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    learned: Array.isArray(parsed.learned) ? parsed.learned : [],
    needs_age_check: Boolean(parsed.needs_age_check),
    escalate: typeof parsed.escalate === 'string' ? parsed.escalate : null,
  };
}
