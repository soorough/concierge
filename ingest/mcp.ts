import { safeFetch } from './fetch.js';

/**
 * Shopify's Storefront MCP.
 *
 * Every Shopify storefront exposes `/api/mcp` unauthenticated, and a store that offers
 * `update_cart` will price a cart properly — applying automatic promotions and returning a
 * real checkout URL. Constructing a `/cart/{variant}:{qty}` permalink cannot do that: the
 * product feed carries list prices, so our card said $20.00 against a real charge of $17.00.
 *
 * Availability is per-store and cannot be assumed. Of four brands tested, three expose all
 * five tools and one exposes only policy search, so every use of this is a preference with
 * the hand-built path still behind it.
 */
export type McpTool =
  | 'search_catalog'
  | 'get_cart'
  | 'update_cart'
  | 'search_shop_policies_and_faqs'
  | 'get_product_details';

const RPC_HEADERS = {
  'content-type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

async function rpc<T>(domain: string, method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
  const { res, body } = await safeFetch(`https://${domain}/api/mcp`, {
    timeoutMs,
    headers: RPC_HEADERS,
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  if (!res.ok) throw new Error(`mcp ${method} returned ${res.status}`);
  const parsed = JSON.parse(body) as { result?: T; error?: { message: string } };
  if (parsed.error) throw new Error(`mcp ${method}: ${parsed.error.message}`);
  if (!parsed.result) throw new Error(`mcp ${method}: no result`);
  return parsed.result;
}

/** Which tools a storefront offers, or an empty list if it offers none. */
export async function discoverMcpTools(domain: string): Promise<McpTool[]> {
  try {
    const result = await rpc<{ tools: { name: string }[] }>(domain, 'tools/list', undefined, 10_000);
    return result.tools.map((t) => t.name as McpTool);
  } catch {
    return [];
  }
}

export type McpCartLine = {
  variantId: string;
  quantity: number;
  subtotalCents: number;
  totalCents: number;
};

export type McpCart = {
  cartId: string;
  checkoutUrl: string;
  subtotalCents: number;
  totalCents: number;
  discounts: { title: string; amountCents: number }[];
  lines: McpCartLine[];
};

const toCents = (amount: string | number | undefined): number =>
  amount === undefined ? 0 : Math.round(Number(amount) * 100);

/**
 * Price a cart against the store itself. `cartId` continues an existing cart so a customer
 * changing quantities does not leave a trail of abandoned ones.
 */
export async function priceCartViaMcp(
  domain: string,
  lines: { variantId: string; quantity: number }[],
  cartId?: string | null,
): Promise<McpCart | null> {
  if (!lines.length) return null;

  try {
    const result = await rpc<{ content: { text: string }[] }>(
      domain,
      'tools/call',
      {
        name: 'update_cart',
        arguments: {
          ...(cartId ? { cart_id: cartId } : {}),
          add_items: lines.map((l) => ({ product_variant_id: l.variantId, quantity: l.quantity })),
        },
      },
      20_000,
    );

    const text = result.content?.[0]?.text;
    if (!text) return null;
    const payload = JSON.parse(text) as { cart?: Record<string, unknown> };
    const cart = (payload.cart ?? payload) as Record<string, any>;
    if (!cart?.id || !cart?.checkout_url) return null;

    const cartLines = (cart.lines ?? []) as any[];
    return {
      cartId: String(cart.id),
      checkoutUrl: String(cart.checkout_url),
      subtotalCents: toCents(cart.cost?.subtotal_amount?.amount),
      totalCents: toCents(cart.cost?.total_amount?.amount),
      discounts: cartLines
        .flatMap((l) => l.applied_discounts ?? [])
        .map((d: any) => ({
          title: String(d.title ?? 'Discount'),
          amountCents: toCents(d.discounted_amount?.amount),
        })),
      lines: cartLines.map((l) => ({
        variantId: String(l.merchandise?.id ?? ''),
        quantity: Number(l.quantity ?? 0),
        subtotalCents: toCents(l.cost?.subtotal_amount?.amount),
        totalCents: toCents(l.cost?.total_amount?.amount),
      })),
    };
  } catch {
    // Any failure falls back to the constructed permalink rather than blocking a checkout.
    return null;
  }
}
