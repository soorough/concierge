import { getDb, id } from '../store/db.js';

export type CartLine = {
  product_id: string; variant_id: string | null; qty: number;
  title: string; price_cents: number; image_url: string | null; url: string;
  sku: string | null; product_type: string | null;
};

export type CartView = {
  cartId: string;
  lines: CartLine[];
  subtotalCents: number;
  currency: string;
  permalink: string | null;
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
    currency: lines[0]?.currency ?? 'USD',
    permalink,
  };
}
