import { getDb } from '../store/db.js';
import { currentFacts, type Fact } from '../store/ledger.js';
import { recentTurns, type TurnRow } from '../store/session.js';

export type RetrievedProduct = {
  id: string; sku: string | null; variant_id: string | null; title: string;
  price_cents: number; currency: string; available: number;
  product_type: string | null; description: string; url: string; image_url: string | null;
};

/**
 * FTS5 MATCH takes a query syntax, not raw user text — an apostrophe or a bare `AND`
 * is a syntax error. Tokens are extracted, quoted, and OR-ed so a multi-word question
 * still returns the best partial matches.
 */
export function toFtsQuery(text: string): string | null {
  // Deduplicate before capping. Conversation text repeats heavily, and an undeduplicated
  // cap spent all twelve slots on filler from the newest message — dropping the product
  // name from the agent's own reply, which is exactly the term that matters.
  const tokens = Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ).slice(0, 24);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

const STOPWORDS = new Set([
  'the','and','for','you','your','are','can','what','with','have','has','how','does',
  'this','that','from','they','get','got','any','all','out','about','would','could','should',
  'want','need','like','into','was','were','been','but','not','who','why','when','where',
]);

export type Retrieval = {
  products: RetrievedProduct[];
  /** True when the slice contains the genuinely cheapest sellable products, so
   *  "what's your cheapest" is answerable rather than a guess over a text match. */
  priceOrdered: boolean;
  policies: { kind: string; text: string; source_url: string }[];
  facts: Fact[];
  history: TurnRow[];
  cartProducts: RetrievedProduct[];
};

const SMALL_CATALOG = 60;

const PRICE_INTENT =
  /\b(cheap(est|er)?|least expensive|most affordable|budget|inexpensive|lowest price|under \$?\d+|below \$?\d+|less than \$?\d+|entry level|starting at)\b/i;

/**
 * FTS ranks by text relevance, which cannot answer "what's your cheapest". Asking the
 * model to rank a twelve-item slice invites a confident superlative about a catalog it
 * has never seen, so price questions get the actual price-ordered head of the catalog.
 */
function cheapestSellable(db: ReturnType<typeof getDb>, brandId: string, limit: number): RetrievedProduct[] {
  return db
    .prepare(
      `select id, sku, variant_id, title, price_cents, currency, available,
              product_type, description, url, image_url
       from product where brand_id = ? and sellable = 1 and available = 1
       order by price_cents asc limit ?`,
    )
    .all(brandId, limit) as RetrievedProduct[];
}

export function retrieve(opts: {
  brandId: string;
  customerId: string;
  message: string;
  limit?: number;
}): Retrieval {
  const db = getDb();
  const { brandId, customerId, message } = opts;
  const limit = opts.limit ?? 12;

  const history = recentTurns(customerId, 8);

  /*
   * Retrieval keys off the conversation, not just the latest message. "give me that one"
   * carries no product terms, so querying it alone returns a slice without the wine under
   * discussion — and the no-invented-SKU rule then makes the agent deny carrying something
   * it just recommended.
   *
   * Both sides of the conversation matter, and the agent's own replies matter more than
   * they look: when the customer says "that one", the referent was named by the agent,
   * never by them.
   */
  const recentText = [
    ...history.filter((t) => t.direction === 'in' && t.text).slice(-3).map((t) => t.text!),
    ...history.filter((t) => t.direction === 'out' && t.text).slice(-2).map((t) => t.text!),
  ].join(' ');

  const sellableCount = (
    db.prepare('select count(*) c from product where brand_id = ? and sellable = 1').get(brandId) as { c: number }
  ).c;

  const query = toFtsQuery(`${message} ${recentText}`);
  let products: RetrievedProduct[];

  if (sellableCount <= SMALL_CATALOG) {
    products = db
      .prepare(
        `select id, sku, variant_id, title, price_cents, currency, available,
                product_type, description, url, image_url
         from product where brand_id = ? and sellable = 1 order by price_cents`,
      )
      .all(brandId) as RetrievedProduct[];
  } else if (query) {
    products = db
      .prepare(
        `select p.id, p.sku, p.variant_id, p.title, p.price_cents, p.currency, p.available,
                p.product_type, p.description, p.url, p.image_url
         from product_fts f join product p on p.rowid = f.rowid
         where product_fts match ? and p.brand_id = ? and p.sellable = 1
         order by bm25(product_fts) limit ?`,
      )
      .all(query, brandId, limit) as RetrievedProduct[];
  } else {
    products = [];
  }

  const priceOrdered = PRICE_INTENT.test(message);
  if (priceOrdered) {
    const cheap = cheapestSellable(db, brandId, 8);
    const seen = new Set(products.map((p) => p.id));
    products = [...cheap.filter((p) => !seen.has(p.id)), ...products];
  }

  // Anything already in the cart stays in context regardless of the current message.
  const cartProducts = db
    .prepare(
      `select p.id, p.sku, p.variant_id, p.title, p.price_cents, p.currency, p.available,
              p.product_type, p.description, p.url, p.image_url
       from cart_line cl
       join cart c on c.id = cl.cart_id
       join product p on p.id = cl.product_id
       where c.customer_id = ? and c.status = 'open'`,
    )
    .all(customerId) as RetrievedProduct[];

  const policies = query
    ? (db
        .prepare(
          `select pc.kind, pc.text, pc.source_url
           from policy_fts f join policy_chunk pc on pc.rowid = f.rowid
           where policy_fts match ? and pc.brand_id = ?
           order by bm25(policy_fts) limit 3`,
        )
        .all(query, brandId) as { kind: string; text: string; source_url: string }[])
    : [];

  return {
    products,
    priceOrdered,
    policies,
    facts: currentFacts(customerId),
    history,
    cartProducts,
  };
}
