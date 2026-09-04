import { routeTurn } from '../agent/route.js';
import { cartDisagreement, variantKey, type CartView } from '../agent/cart.js';
import { TOOL_SPECS } from '../agent/toolspec.js';

export type Case = { name: string; run: () => { pass: boolean; got: string } };

const cart = (over: Partial<CartView> = {}): CartView => ({
  cartId: 'cart_1',
  lines: [
    {
      product_id: 'prod_1',
      variant_id: '111',
      qty: 1,
      title: 'Vintner Cabernet Sauvignon 2023',
      price_cents: 2900,
      image_url: null,
      url: 'https://example.test/p',
      sku: 'VCS-2023',
      product_type: 'Wine',
    },
  ],
  subtotalCents: 2900,
  totalCents: 2900,
  discounts: [],
  currency: 'USD',
  permalink: 'https://example.test/checkout',
  pricedBy: 'store',
  storeLines: [{ variantId: 'gid://shopify/ProductVariant/111', quantity: 1 }],
  ...over,
});

export const AGENT_CASES: Case[] = [
  // --- routing: which turns are worth a loop
  {
    name: 'a question the catalog already answers takes the single-call path',
    run: () => {
      const r = routeTurn({ message: 'what goes with a ribeye?', cartLines: 0 });
      return { pass: !r.useTools, got: `${r.useTools} (${r.reason})` };
    },
  },
  {
    name: 'a price question routes to tools',
    run: () => {
      const r = routeTurn({ message: 'how much is the cabernet?', cartLines: 0 });
      return { pass: r.useTools, got: r.reason };
    },
  },
  {
    name: 'a budget question routes to tools',
    run: () => {
      const r = routeTurn({ message: 'anything good under $40?', cartLines: 0 });
      return { pass: r.useTools, got: r.reason };
    },
  },
  {
    name: 'an availability question routes to tools',
    run: () => {
      const r = routeTurn({ message: 'do you have that one in stock?', cartLines: 0 });
      return { pass: r.useTools, got: r.reason };
    },
  },
  {
    name: 'a terms question routes to tools, since terms are not carried in the prompt',
    run: () => {
      const r = routeTurn({ message: 'can I cancel the wine club subscription?', cartLines: 0 });
      return { pass: r.useTools, got: r.reason };
    },
  },
  {
    name: 'intent to buy routes to tools even with no price named',
    run: () => {
      const r = routeTurn({ message: "I'll take the pinot", cartLines: 0 });
      return { pass: r.useTools, got: r.reason };
    },
  },
  {
    name: 'an open cart routes to tools, because the next turn may commit',
    run: () => {
      const r = routeTurn({ message: 'tell me about that one', cartLines: 1 });
      return { pass: r.useTools, got: r.reason };
    },
  },
  {
    name: 'a bare thank-you does not spend a tool call',
    run: () => {
      const r = routeTurn({ message: 'thanks, that helps!', cartLines: 0 });
      return { pass: !r.useTools, got: r.reason };
    },
  },

  // --- the tool surface itself
  {
    name: 'no tool is offered that only repeats what the prompt already contains',
    run: () => {
      const names = TOOL_SPECS.map((t) => t.name);
      const banned = ['read_facts', 'write_cart', 'add_to_cart'];
      const leaked = names.filter((n) => banned.includes(n));
      return { pass: leaked.length === 0, got: names.join(',') };
    },
  },
  {
    name: 'every offered tool takes a catalog reference or a query, never a product title',
    run: () => {
      const bad = TOOL_SPECS.filter((t) => {
        const props = Object.keys((t.inputSchema as any).properties ?? {});
        return !props.every((p) => p === 'ref' || p === 'query');
      });
      return { pass: bad.length === 0, got: bad.map((t) => t.name).join(',') || 'all clean' };
    },
  },

  // --- the cart, checked against the store rather than against ourselves
  {
    name: 'a cart the store confirms raises nothing',
    run: () => {
      const d = cartDisagreement(cart());
      return { pass: d === null, got: d ?? 'null' };
    },
  },
  {
    name: 'a line the store dropped is caught',
    run: () => {
      const d = cartDisagreement(cart({ storeLines: [] }));
      return { pass: d !== null && /not in the store/.test(d), got: d ?? 'null' };
    },
  },
  {
    name: 'a quantity the store clamped is caught',
    run: () => {
      const d = cartDisagreement(
        cart({ storeLines: [{ variantId: 'gid://shopify/ProductVariant/111', quantity: 1 }], lines: [{ ...cart().lines[0], qty: 5 }] }),
      );
      return { pass: d !== null && /we say 5, the store says 1/.test(d), got: d ?? 'null' };
    },
  },
  {
    name: 'an item only the store has is caught',
    run: () => {
      const d = cartDisagreement(
        cart({
          storeLines: [
            { variantId: 'gid://shopify/ProductVariant/111', quantity: 1 },
            { variantId: 'gid://shopify/ProductVariant/999', quantity: 2 },
          ],
        }),
      );
      return { pass: d !== null && /extra variant 999/.test(d), got: d ?? 'null' };
    },
  },
  {
    name: 'a cart the store never priced is not judged against it',
    run: () => {
      const d = cartDisagreement(cart({ pricedBy: 'catalog', storeLines: undefined }));
      return { pass: d === null, got: d ?? 'null' };
    },
  },
  {
    name: 'a Shopify global id compares equal to the bare variant id we store',
    run: () => {
      const got = variantKey('gid://shopify/ProductVariant/111');
      return { pass: got === '111', got };
    },
  },
];
