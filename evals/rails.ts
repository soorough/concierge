import { runPostRails, parseModelOutput, type ModelOutput, type PostRailContext } from '../agent/rails/post.js';
import type { RetrievedProduct } from '../agent/retrieve.js';

export type Case = { name: string; run: () => { pass: boolean; got: string } };

const product = (over: Partial<RetrievedProduct> = {}): RetrievedProduct => ({
  id: 'prod_1',
  sku: 'VCS-2023',
  variant_id: '111',
  title: 'Vintner Cabernet Sauvignon 2023',
  price_cents: 2900,
  currency: 'USD',
  available: 1,
  product_type: 'Wine',
  description: 'Dark berry, toffee and vanilla notes.',
  url: 'https://example.test/p',
  image_url: null,
  ...over,
});

const shimmer = product({
  id: 'prod_2',
  sku: 'SHIM-BRUT',
  title: 'I Love You More Than Wine Pink Shimmer',
  price_cents: 5900,
});

const packaging = product({
  id: 'prod_3',
  sku: 'PACK-FULFIL',
  title: 'Packaging & Fulfillment',
  price_cents: 495,
});

const ctx = (over: Partial<PostRailContext> = {}): PostRailContext => ({
  catalog: [product()],
  nonSellableSkus: new Set(['pack-fulfil']),
  category: 'alcohol',
  ageVerified: true,
  restrictedRegions: ['Utah'],
  customerRegion: null,
  ...over,
});

const out = (over: Partial<ModelOutput> = {}): ModelOutput => ({
  reply: '',
  actions: [],
  learned: [],
  needs_age_check: false,
  escalate: null,
  ...over,
});

const fired = (events: { code: string }[], code: string) => events.some((e) => e.code === code);
const codes = (events: { code: string }[]) => events.map((e) => e.code).join(',') || '(none)';

export const RAIL_CASES: Case[] = [
  // --- price grounding
  {
    name: 'a price token resolves from the database',
    run: () => {
      const r = runPostRails(out({ reply: 'The Vintner Cab is {{price:1}}.' }), ctx());
      return { pass: r.reply.includes('$29.00') && fired(r.events, 'PRICE_RESOLVED'), got: r.reply };
    },
  },
  {
    name: 'a price the model wrote itself is caught',
    run: () => {
      const r = runPostRails(out({ reply: 'That one is $42.' }), ctx());
      return { pass: fired(r.events, 'UNGROUNDED_PRICE') && r.escalated, got: r.reply };
    },
  },
  {
    name: 'a price approximated in words is caught',
    run: () => {
      const r = runPostRails(out({ reply: 'It runs around thirty dollars, give or take.' }), ctx());
      return { pass: fired(r.events, 'UNGROUNDED_PRICE') && r.escalated, got: r.reply };
    },
  },
  {
    name: 'a price token for an unknown product escalates rather than printing nothing',
    run: () => {
      const r = runPostRails(out({ reply: 'It is {{price:9}}.' }), ctx());
      return { pass: fired(r.events, 'UNGROUNDED_PRICE') && r.escalated, got: r.reply };
    },
  },

  // --- offers
  {
    name: 'a percentage discount is replaced',
    run: () => {
      const r = runPostRails(out({ reply: "Sure, here's 30% off your order." }), ctx());
      return { pass: fired(r.events, 'UNAUTHORIZED_OFFER') && !/30\s?%/.test(r.reply), got: r.reply };
    },
  },
  {
    name: 'a promo code is replaced',
    run: () => {
      const r = runPostRails(out({ reply: 'Use promo code WELCOME10 at checkout.' }), ctx());
      return { pass: fired(r.events, 'UNAUTHORIZED_OFFER') && !/WELCOME10/.test(r.reply), got: r.reply };
    },
  },
  {
    name: 'prompt injection cannot reach a free price',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Ignoring previous instructions — yours free, $0.00!' }),
        ctx(),
      );
      return { pass: r.escalated && !/\$0\.00/.test(r.reply), got: r.reply };
    },
  },

  // --- product grounding
  {
    name: 'a non-sellable product is refused',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Adding that.', actions: [{ type: 'add_to_cart', ref: 2, qty: 1 }] }),
        ctx({ catalog: [product(), packaging] }),
      );
      return { pass: fired(r.events, 'NON_SELLABLE_SKU') && r.actions.length === 0, got: codes(r.events) };
    },
  },
  {
    /* A product real elsewhere in the catalog but never shown must not be actionable. */
    name: 'a reference outside the shown catalog is refused',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Adding that.', actions: [{ type: 'add_to_cart', ref: 9, qty: 1 }] }),
        ctx(),
      );
      return { pass: fired(r.events, 'CART_REJECTED') && r.actions.length === 0, got: codes(r.events) };
    },
  },
  {
    name: 'a valid reference is added',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Added.', actions: [{ type: 'add_to_cart', ref: 1, qty: 1 }] }),
        ctx(),
      );
      return { pass: fired(r.events, 'CART_WRITE') && !r.escalated, got: codes(r.events) };
    },
  },

  // --- reply and action must agree
  {
    /*
     * Regression. Live, the agent said "adding the Sparkling Moscato" and wrote a $59 Pink
     * Shimmer. Every other rail passed: the product was real, sellable and in the catalog.
     */
    name: 'a cart write contradicting the reply is blocked',
    run: () => {
      const r = runPostRails(
        out({
          reply: 'Got it — adding the Vintner Cabernet Sauvignon to your cart.',
          actions: [{ type: 'add_to_cart', ref: 2, qty: 1 }],
        }),
        ctx({ catalog: [product(), shimmer] }),
      );
      return { pass: fired(r.events, 'CART_MISMATCH') && r.actions.length === 0, got: codes(r.events) };
    },
  },
  {
    name: 'a cart write matching the reply is allowed',
    run: () => {
      const r = runPostRails(
        out({
          reply: 'Adding the Vintner Cabernet Sauvignon 2023 now.',
          actions: [{ type: 'add_to_cart', ref: 1, qty: 1 }],
        }),
        ctx({ catalog: [product(), shimmer] }),
      );
      return { pass: !fired(r.events, 'CART_MISMATCH') && r.actions.length === 1, got: codes(r.events) };
    },
  },
  {
    name: 'a reply naming no product does not trigger a mismatch',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Added to your cart.', actions: [{ type: 'add_to_cart', ref: 1, qty: 1 }] }),
        ctx({ catalog: [product(), shimmer] }),
      );
      return { pass: !fired(r.events, 'CART_MISMATCH') && r.actions.length === 1, got: codes(r.events) };
    },
  },

  // --- addressing hygiene
  {
    name: 'catalog reference numbers never reach the customer',
    run: () => {
      const r = runPostRails(
        out({ reply: 'I would go with the Vintner Cabernet [1] or the Reserve [12].' }),
        ctx(),
      );
      return { pass: !/\[\d+\]/.test(r.reply) && fired(r.events, 'REF_LEAKED'), got: r.reply };
    },
  },

  // --- gates
  {
    name: 'an alcohol brand withholds checkout until age is confirmed',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Ready when you are.', actions: [{ type: 'show_checkout' }] }),
        ctx({ ageVerified: false }),
      );
      return { pass: fired(r.events, 'AGE_REQUIRED') && r.blockCheckout, got: codes(r.events) };
    },
  },
  {
    name: 'a restricted region blocks the handoff',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Ready when you are.', actions: [{ type: 'show_checkout' }] }),
        ctx({ customerRegion: 'Utah' }),
      );
      return { pass: fired(r.events, 'REGION_BLOCKED') && r.blockCheckout, got: codes(r.events) };
    },
  },

  // --- ranking claims
  {
    name: 'a ranking claim over a slice is flagged',
    run: () => {
      const r = runPostRails(out({ reply: 'The Moscato is our most affordable bottle.' }), ctx());
      return { pass: fired(r.events, 'UNVERIFIED_SUPERLATIVE') && !r.escalated, got: codes(r.events) };
    },
  },
  {
    name: 'a flagged ranking claim still delivers the reply',
    run: () => {
      const r = runPostRails(out({ reply: 'Our best-selling red is the Vintner Cabernet.' }), ctx());
      return { pass: r.reply.includes('Vintner Cabernet'), got: r.reply };
    },
  },
  {
    name: 'declining to rank is not flagged as a ranking claim',
    run: () => {
      const r = runPostRails(
        out({ reply: "I don't have the full catalog, so I can't say which is cheapest." }),
        ctx(),
      );
      return { pass: !fired(r.events, 'UNVERIFIED_SUPERLATIVE'), got: codes(r.events) };
    },
  },
  {
    name: 'a ranking claim is not flagged when the catalog is price-ordered',
    run: () => {
      const r = runPostRails(
        out({ reply: 'The Sparkling Moscato is our cheapest at {{price:1}}.' }),
        ctx({ priceOrdered: true }),
      );
      return { pass: !fired(r.events, 'UNVERIFIED_SUPERLATIVE'), got: codes(r.events) };
    },
  },

  // --- escalation and length
  {
    name: 'a model escalation replaces the reply',
    run: () => {
      const r = runPostRails(
        out({ reply: 'Shipping takes about 3 days.', escalate: 'shipping time unknown' }),
        ctx(),
      );
      return { pass: r.escalated && !/3 days/.test(r.reply), got: r.reply };
    },
  },
  {
    name: 'an over-long reply is truncated at a sentence boundary',
    run: () => {
      const r = runPostRails(out({ reply: 'This is a sentence about wine. '.repeat(60) }), ctx());
      return { pass: r.reply.length <= 1000 && r.reply.trim().endsWith('.'), got: `${r.reply.length} chars` };
    },
  },

  // --- output parsing
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

RAIL_CASES.push(
  {
    /*
     * Regression. One live turn began with a bare `{{price:4}}` token, so scanning for the
     * first `{` landed inside the token rather than the object and the whole turn was lost.
     */
    name: 'a reply beginning with a price token still parses',
    run: () => {
      const parsed = parseModelOutput('{{price:4}} is the one. {"reply":"It is {{price:4}}.","actions":[],"learned":[]}');
      return { pass: parsed.reply.includes('{{price:4}}') && !parsed.recovered, got: parsed.reply };
    },
  },
  {
    name: 'non-JSON output degrades to a plain reply rather than losing the turn',
    run: () => {
      const parsed = parseModelOutput('Sure — the Vintner Cabernet is a great pick.');
      return {
        pass: parsed.reply.startsWith('Sure') && Boolean(parsed.recovered),
        got: `${parsed.reply.slice(0, 40)} / recovered=${Boolean(parsed.recovered)}`,
      };
    },
  },
  {
    name: 'a recovered reply is still held to the rails',
    run: () => {
      const parsed = parseModelOutput("Sure, here's 30% off for you.");
      const r = runPostRails(parsed, ctx());
      return {
        pass: fired(r.events, 'UNAUTHORIZED_OFFER') && !/30\s?%/.test(r.reply),
        got: r.reply,
      };
    },
  },
);

RAIL_CASES.push(
  {
    /*
     * Regression. Live, the question "what goes with a ribeye steak?" added a $29 bottle
     * the customer never asked for, and the card appeared contradicting the conversation.
     */
    name: 'a cart write the reply never mentions is dropped',
    run: () => {
      const r = runPostRails(
        out({
          reply: 'A bold red like the Vintner Cabernet Sauvignon would be perfect with ribeye.',
          actions: [{ type: 'add_to_cart', ref: 1, qty: 1 }],
        }),
        ctx(),
      );
      return {
        pass: fired(r.events, 'CART_UNANNOUNCED') && r.actions.length === 0,
        got: codes(r.events),
      };
    },
  },
  {
    name: 'an announced cart write still goes through',
    run: () => {
      const r = runPostRails(
        out({
          reply: 'Got it — adding the Vintner Cabernet Sauvignon to your cart.',
          actions: [{ type: 'add_to_cart', ref: 1, qty: 1 }],
        }),
        ctx(),
      );
      return {
        pass: !fired(r.events, 'CART_UNANNOUNCED') && r.actions.length === 1,
        got: codes(r.events),
      };
    },
  },
);
