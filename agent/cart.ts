import { getDb, id } from '../store/db.js';
import { priceCartViaMcp } from '../ingest/mcp.js';

export type CartLine = {
  product_id: string; variant_id: string | null; qty: number;
  title: string; price_cents: number; image_url: string | null; url: string;
  sku: string | null; product_type: string | null;
};

export type CartView = {
  cartId: string;
  lines: CartLine[];
  /** Sum of list prices from the catalog. */
  subtotalCents: number;
  /** What the store says the customer pays, when it will tell us. */
  totalCents: number | null;
  discounts: { title: string; amountCents: number }[];
  currency: string;
  permalink: string | null;
  /** 'store' when the store priced it, 'catalog' when we constructed the handoff. */
  pricedBy: 'store' | 'catalog';
};

function openCart(customerId: string): string {
  const db = getDb();
  const existing = db
    .prepare("select id from cart where customer_id = ? and status = 'open'")
    .get(customerId) as { id: string } | undefined;
  if (existing) return existing.id;
  const cartId = id('cart');
  db.prepare('insert into cart (id, customer_id, status, updated_at) values (?,?,?,?)')
    .run(cartId, customerId, 'open', Date.now());
  return cartId;
}

export function addToCart(customerId: string, productId: string, qty = 1): void {
  const db = getDb();
  const cartId = openCart(customerId);
  const product = db.prepare('select variant_id from product where id = ?').get(productId) as
    | { variant_id: string | null }
    | undefined;
  db.prepare(
    `insert into cart_line (cart_id, product_id, variant_id, qty) values (?,?,?,?)
     on conflict(cart_id, product_id) do update set qty = qty + excluded.qty`,
  ).run(cartId, productId, product?.variant_id ?? null, qty);
  db.prepare('update cart set updated_at = ? where id = ?').run(Date.now(), cartId);
}

export function setQty(customerId: string, productId: string, qty: number): void {
  const db = getDb();
  const cartId = openCart(customerId);
  if (qty <= 0) {
    db.prepare('delete from cart_line where cart_id = ? and product_id = ?').run(cartId, productId);
  } else {
    db.prepare('update cart_line set qty = ? where cart_id = ? and product_id = ?')
      .run(qty, cartId, productId);
  }
  db.prepare('update cart set updated_at = ? where id = ?').run(Date.now(), cartId);
}

export function clearCart(customerId: string): void {
  const db = getDb();
  const cartId = openCart(customerId);
  db.prepare('delete from cart_line where cart_id = ?').run(cartId);
}

/**
 * The subtotal is computed from database prices, never from anything the model said.
 * The handoff is a real Shopify cart permalink — `/cart/{variant}:{qty}` lands the
 * customer on the brand's own cart, pre-filled. Non-Shopify brands fall back to the
 * product URL, and the console labels the difference.
 */
/**
 * Ask the store to price the cart when it will.
 *
 * A product feed carries list prices, so a locally computed subtotal misses automatic
 * promotions — ONEHOPE's card read $20.00 against a real charge of $17.00. Where the
 * storefront exposes `update_cart`, it returns the true total, the discounts by name, and a
 * genuine checkout URL. Where it does not, the constructed permalink still works.
 */
export async function getCartPriced(
  customerId: string,
  domain: string,
  ingestPath: string,
  mcpTools: string[],
): Promise<CartView> {
  const local = getCart(customerId, domain, ingestPath);
  if (!local.lines.length || !mcpTools.includes('update_cart')) return local;

  const db = getDb();

  /*
   * `update_cart` adds rather than sets, so reusing a remote cart id accumulates: one bottle
   * priced twice showed a $6.00 discount on a $34.00 total for a single $20.00 item. The
   * local cart is the source of truth and the remote cart is a pricing artifact, so a
   * changed cart gets a fresh one.
   *
   * The signature keeps that from costing a network call on every turn: unchanged contents
   * reuse the stored total, and only a real change is re-priced.
   */
  const signature = local.lines
    .map((l) => `${l.variant_id}:${l.qty}`)
    .sort()
    .join(',');

  const row = db
    .prepare('select remote_cart_id, remote_total_cents, remote_discounts_json, remote_signature, permalink from cart where id = ?')
    .get(local.cartId) as
    | {
        remote_cart_id: string | null;
        remote_total_cents: number | null;
        remote_discounts_json: string | null;
        remote_signature: string | null;
        permalink: string | null;
      }
    | undefined;

  if (row?.remote_signature === signature && row.remote_total_cents !== null) {
    return {
      ...local,
      totalCents: row.remote_total_cents,
      discounts: JSON.parse(row.remote_discounts_json ?? '[]'),
      permalink: row.permalink ?? local.permalink,
      pricedBy: 'store',
    };
  }

  const priced = await priceCartViaMcp(
    domain,
    local.lines
      .filter((l) => l.variant_id)
      .map((l) => ({ variantId: `gid://shopify/ProductVariant/${l.variant_id}`, quantity: l.qty })),
    // Deliberately not continuing the previous cart — see above.
    null,
  );
  if (!priced) return local;

  db.prepare(
    `update cart set remote_cart_id = ?, remote_total_cents = ?, remote_discounts_json = ?,
                     remote_signature = ?, permalink = ? where id = ?`,
  ).run(
    priced.cartId,
    priced.totalCents,
    JSON.stringify(priced.discounts),
    signature,
    priced.checkoutUrl,
    local.cartId,
  );

  return {
    ...local,
    totalCents: priced.totalCents,
    discounts: priced.discounts,
    permalink: priced.checkoutUrl,
    pricedBy: 'store',
  };
}

export function getCart(customerId: string, domain: string, ingestPath: string): CartView {
  const db = getDb();
  const cartId = openCart(customerId);
  const lines = db
    .prepare(
      `select cl.product_id, cl.variant_id, cl.qty, p.title, p.price_cents,
              p.image_url, p.url, p.sku, p.product_type, p.currency
       from cart_line cl join product p on p.id = cl.product_id
       where cl.cart_id = ?`,
    )
    .all(cartId) as (CartLine & { currency: string })[];

  const subtotalCents = lines.reduce((sum, l) => sum + l.price_cents * l.qty, 0);

  let permalink: string | null = null;
  if (lines.length) {
    const withVariants = lines.filter((l) => l.variant_id);
    if (ingestPath === 'shopify' && withVariants.length === lines.length) {
      permalink = `https://${domain}/cart/${lines.map((l) => `${l.variant_id}:${l.qty}`).join(',')}`;
    } else {
      permalink = lines[0].url;
    }
    db.prepare('update cart set permalink = ? where id = ?').run(permalink, cartId);
  }

  return {
    cartId,
    lines,
    subtotalCents,
    totalCents: null,
    discounts: [],
    currency: lines[0]?.currency ?? 'USD',
    permalink,
    pricedBy: 'catalog',
  };
}
