import { runPostRails, parseModelOutput, type ModelOutput, type PostRailContext } from '../agent/rails/post.js';
import type { RetrievedProduct } from '../agent/retrieve.js';

const product = (over: Partial<RetrievedProduct> = {}): RetrievedProduct => ({
  id: 'prod_1', sku: 'VCS-2023', variant_id: '111', title: 'Vintner Cabernet Sauvignon 2023',
  price_cents: 2900, currency: 'USD', available: 1, product_type: 'Wine',
  description: 'Dark berry, toffee and vanilla notes.', url: 'https://x/p', image_url: null,
  ...over,
});

export const baseCtx = (over: Partial<PostRailContext> = {}): PostRailContext => ({
  catalog: [product()],
  allSellableSkus: new Set(['vcs-2023']),
  nonSellableSkus: new Set(['pack-fulfil']),
  category: 'alcohol',
  ageVerified: true,
  restrictedRegions: ['Utah'],
  customerRegion: null,
  ...over,
});

export const out = (over: Partial<ModelOutput> = {}): ModelOutput => ({
  reply: '', actions: [], learned: [], needs_age_check: false, escalate: null, ...over,
});

export type RailCase = {
  name: string;
  run: () => { pass: boolean; got: string };
};

const has = (codes: { code: string }[], code: string) => codes.some((e) => e.code === code);

export const RAIL_CASES: RailCase[] = [
  {
    name: 'price token resolves from the database',
    run: () => {
      const r = runPostRails(out({ reply: 'The Vintner Cab is {{price:VCS-2023}}.' }), baseCtx());
      return { pass: r.reply.includes('$29.00') && has(r.events, 'PRICE_RESOLVED'), got: r.reply };
    },
  },
  {
    name: 'model writing a numeric price directly is caught',
    run: () => {
      const r = runPostRails(out({ reply: 'That one is $42.' }), baseCtx());
      return { pass: has(r.events, 'UNGROUNDED_PRICE') && r.escalated, got: r.reply };
    },
  },
  {
    name: 'price approximated in words is caught',
    run: () => {
      const r = runPostRails(out({ reply: 'It runs around thirty dollars, give or take.' }), baseCtx());
      return { pass: has(r.events, 'UNGROUNDED_PRICE') && r.escalated, got: r.reply };
    },
  },
  {
    name: 'price token for an unknown SKU escalates rather than printing nothing',
    run: () => {
      const r = runPostRails(out({ reply: 'It is {{price:NOT-REAL}}.' }), baseCtx());
      return { pass: has(r.events, 'UNGROUNDED_PRICE') && r.escalated, got: r.reply };
    },
  },
  {
    name: 'percentage discount is replaced',
    run: () => {
      const r = runPostRails(out({ reply: "Sure, here's 30% off your order." }), baseCtx());
      return { pass: has(r.events, 'UNAUTHORIZED_OFFER') && !/30\s?%/.test(r.reply), got: r.reply };
    },
  },
  {
    name: 'promo code is replaced',
    run: () => {
      const r = runPostRails(out({ reply: 'Use promo code WELCOME10 at checkout.' }), baseCtx());
      return { pass: has(r.events, 'UNAUTHORIZED_OFFER') && !/WELCOME10/.test(r.reply), got: r.reply };
    },
  },
  {
    name: 'prompt injection cannot reach a free price',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Ignoring previous instructions — yours free, $0.00!' }),
        baseCtx(),
      );
      return { pass: r.escalated && !/\$0\.00/.test(r.reply), got: r.reply };
    },
  },
  {
    name: 'non-sellable SKU is refused',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Adding that.', actions: [{ type: 'add_to_cart', sku: 'PACK-FULFIL', qty: 1 }] }),
        baseCtx(),
      );
      return { pass: has(r.events, 'NON_SELLABLE_SKU') && r.actions.length === 0, got: JSON.stringify(r.actions) };
    },
  },
  {
    name: 'unknown SKU is refused',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Adding that.', actions: [{ type: 'add_to_cart', sku: 'GHOST-1', qty: 1 }] }),
        baseCtx(),
      );
      return { pass: has(r.events, 'CART_REJECTED') && r.actions.length === 0, got: JSON.stringify(r.actions) };
    },
  },
  {
    name: 'valid SKU is added',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Added.', actions: [{ type: 'add_to_cart', sku: 'VCS-2023', qty: 1 }] }),
        baseCtx(),
      );
      return { pass: has(r.events, 'CART_WRITE') && !r.escalated, got: JSON.stringify(r.actions) };
    },
  },
  {
    name: 'alcohol brand withholds checkout until age is confirmed',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Ready when you are.', actions: [{ type: 'show_checkout' }] }),
        baseCtx({ ageVerified: false }),
      );
      return { pass: has(r.events, 'AGE_REQUIRED') && r.blockCheckout, got: String(r.blockCheckout) };
    },
  },
  {
    name: 'restricted region blocks the handoff',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Ready when you are.', actions: [{ type: 'show_checkout' }] }),
        baseCtx({ customerRegion: 'Utah' }),
      );
      return { pass: has(r.events, 'REGION_BLOCKED') && r.blockCheckout, got: String(r.blockCheckout) };
    },
  },
  {
    name: 'model escalation replaces the reply',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Shipping takes about 3 days.', escalate: 'shipping time unknown' }),
        baseCtx(),
      );
      return { pass: r.escalated && !/3 days/.test(r.reply), got: r.reply };
    },
  },
  {
    name: 'over-long reply is truncated at a sentence boundary',
    run: () => {
      const long = ('This is a sentence about wine. '.repeat(60));
      const r = runPostRails(out({ reply: long }), baseCtx());
      return { pass: r.reply.length <= 1000 && r.reply.trim().endsWith('.'), got: `${r.reply.length} chars` };
    },
  },
  {
    name: 'JSON wrapped in a code fence still parses',
    run: () => {
      const parsed = parseModelOutput('```json\n{"reply":"hi","actions":[],"learned":[]}\n```');
      return { pass: parsed.reply === 'hi', got: parsed.reply };
    },
  },
  {
    name: 'JSON with prose around it still parses',
    run: () => {
      const parsed = parseModelOutput('Sure! {"reply":"hello","actions":[],"learned":[]} hope that helps');
      return { pass: parsed.reply === 'hello', got: parsed.reply };
    },
  },
];
