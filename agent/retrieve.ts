import { getDb } from '../store/db.js';
import { currentFacts, type Fact } from '../store/ledger.js';
import { recentTurns, type TurnRow } from '../store/session.js';

export type RetrievedProduct = {
  id: string;
  sku: string | null;
  variant_id: string | null;
  title: string;
  price_cents: number;
  currency: string;
  available: number;
  product_type: string | null;
  description: string;
  url: string;
  image_url: string | null;
};

/**
 * Policy kinds a customer actually asks about. These are carried in full on every turn
 * rather than retrieved: they are small, stable per brand, and lexical search misses them
 * for exactly the questions people ask — "what if a bottle arrives broken" finds nothing
 * in a policy that says "damage".
 *
 * `terms` is excluded deliberately. It is half the corpus, almost entirely legal
 * boilerplate, and is better retrieved on the rare turn that needs it.
 */
const GROUND_TRUTH_KINDS = ['shipping', 'returns', 'faq', 'about'] as const;

/** Ceiling on always-present policy text, so a verbose brand cannot dominate the prompt. */
const GROUND_TRUTH_CHAR_LIMIT = 24_000;

export type PolicyDoc = { kind: string; text: string; sourceUrl: string; truncated: boolean };

export type Retrieval = {
  /** Every sellable product when the catalog fits, otherwise the lexical slice. */
  products: RetrievedProduct[];
  /** Ids of the lexically closest products, pointed at rather than re-described. */
  detailed: Set<string>;
  /** True when `products` is the complete sellable catalog. */
  complete: boolean;
  /** True when price rankings are answerable from `products` as given. */
  priceOrdered: boolean;
  /** Customer-facing policy carried in full, verbatim from the brand's own pages. */
  groundTruth: PolicyDoc[];
  /** Lexical matches from the remaining policy text, mostly legal terms. */
  policies: { kind: string; text: string; source_url: string }[];
  facts: Fact[];
  history: TurnRow[];
  cartProducts: RetrievedProduct[];
};

const PRODUCT_COLUMNS = `id, sku, variant_id, title, price_cents, currency, available,
                         product_type, description, url, image_url`;

/*
 * How many products can be shown in full rather than retrieved.
 *
 * FTS ranks lexically, so "something that goes with steak" is where it is weakest — none
 * of those words appear in any title. Rather than reach for embeddings, note that a
 * hundred products is a few thousand tokens: the model can be handed the whole catalog
 * and do the semantic matching itself, which it is better at than either BM25 or cosine
 * similarity, and which lets it weigh the cart and the fact ledger at the same time.
 *
 * Embeddings are a compression strategy. They earn their place when the catalog stops
 * fitting, not before.
 */
const FULL_CATALOG_LIMIT = 400;

/** How many lexical matches to highlight when the whole catalog is present. */
const DEFAULT_MATCH_LIMIT = 12;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'can', 'what', 'with', 'have', 'has', 'how',
  'does', 'this', 'that', 'from', 'they', 'get', 'got', 'any', 'all', 'out', 'about',
  'would', 'could', 'should', 'want', 'need', 'like', 'into', 'was', 'were', 'been',
  'but', 'not', 'who', 'why', 'when', 'where',
]);

const PRICE_INTENT =
  /\b(cheap(est|er)?|least expensive|most affordable|budget|inexpensive|lowest price|under \$?\d+|below \$?\d+|less than \$?\d+|entry level|starting at)\b/i;

/**
 * FTS5 MATCH takes a query syntax, not raw user text — an apostrophe or a bare `AND` is a
 * syntax error.
 *
 * Tokens are deduplicated before the cap. Conversation text repeats heavily, and capping
 * first spent every slot on filler from the newest message, dropping the product name out
 * of the agent's own reply — the one term that mattered.
 */
export function toFtsQuery(text: string, maxTokens = 24): string | null {
  const tokens = Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ).slice(0, maxTokens);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' OR ') : null;
}

/**
 * Retrieval keys off the conversation, not just the newest message.
 *
 * "give me that one" carries no product terms, and the referent was named by the agent,
 * never by the customer — so both directions are folded in. Without this the catalog slice
 * arrives without the product under discussion and the no-invented-product rule turns a
 * starved retrieval into a confident denial.
 */
function conversationQuery(message: string, history: TurnRow[]): string | null {
  const inbound = history.filter((t) => t.direction === 'in' && t.text).slice(-3);
  const outbound = history.filter((t) => t.direction === 'out' && t.text).slice(-2);
  const text = [message, ...inbound.map((t) => t.text!), ...outbound.map((t) => t.text!)].join(' ');
  return toFtsQuery(text);
}

export function retrieve(opts: {
  brandId: string;
  customerId: string;
  message: string;
  limit?: number;
}): Retrieval {
  const db = getDb();
  const { brandId, customerId, message } = opts;
  const limit = opts.limit ?? DEFAULT_MATCH_LIMIT;

  const history = recentTurns(customerId, 8);
  const query = conversationQuery(message, history);

  const sellableCount = (
    db.prepare('select count(*) c from product where brand_id = ? and sellable = 1').get(brandId) as {
      c: number;
    }
  ).c;
  const complete = sellableCount <= FULL_CATALOG_LIMIT;

  const matchIds = query
    ? (db
        .prepare(
          `select p.id
           from product_fts f join product p on p.rowid = f.rowid
           where product_fts match ? and p.brand_id = ? and p.sellable = 1
           order by bm25(product_fts) limit ?`,
        )
        .all(query, brandId, limit) as { id: string }[])
    : [];
  const detailed = new Set(matchIds.map((r) => r.id));

  const products = complete
    ? (db
        .prepare(
          `select ${PRODUCT_COLUMNS} from product
           where brand_id = ? and sellable = 1 order by price_cents asc`,
        )
        .all(brandId) as RetrievedProduct[])
    : lexicalSlice(brandId, detailed, PRICE_INTENT.test(message));

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

  const groundTruth = loadGroundTruth(brandId);

  // Retrieval now covers only what is not already present in full.
  const policies = query
    ? (db
        .prepare(
          `select pc.kind, pc.text, pc.source_url
           from policy_fts f join policy_chunk pc on pc.rowid = f.rowid
           where policy_fts match ? and pc.brand_id = ?
             and pc.kind not in (${GROUND_TRUTH_KINDS.map(() => '?').join(',')})
           order by bm25(policy_fts) limit 3`,
        )
        .all(query, brandId, ...GROUND_TRUTH_KINDS) as {
        kind: string;
        text: string;
        source_url: string;
      }[])
    : [];

  return {
    products,
    detailed,
    complete,
    // A complete, price-ordered catalog makes ranking answerable by construction.
    priceOrdered: complete || PRICE_INTENT.test(message),
    groundTruth,
    policies,
    facts: currentFacts(customerId),
    history,
    cartProducts,
  };
}

/**
 * For catalogs too large to show in full: the lexical matches, with the price-ordered head
 * spliced in when the customer asked a price question. FTS ranks by text relevance and so
 * cannot answer "what's your cheapest" — asking a model to rank a twelve-item slice invites
 * a confident superlative about a catalog it has never seen.
 */
function lexicalSlice(brandId: string, ids: Set<string>, priceIntent: boolean): RetrievedProduct[] {
  const db = getDb();
  const matched = ids.size
    ? (db
        .prepare(
          `select ${PRODUCT_COLUMNS} from product where id in (${[...ids].map(() => '?').join(',')})`,
        )
        .all(...ids) as RetrievedProduct[])
    : [];

  if (!priceIntent) return matched;

  const cheapest = db
    .prepare(
      `select ${PRODUCT_COLUMNS} from product
       where brand_id = ? and sellable = 1 and available = 1
       order by price_cents asc limit 8`,
    )
    .all(brandId) as RetrievedProduct[];

  const seen = new Set(matched.map((p) => p.id));
  return [...cheapest.filter((p) => !seen.has(p.id)), ...matched];
}

/**
 * Reassembles each customer-facing policy document from its chunks, in the order they were
 * ingested, so the model reads the brand's own prose rather than three passages a lexical
 * scorer happened to like.
 */
function loadGroundTruth(brandId: string): PolicyDoc[] {
  const rows = getDb()
    .prepare(
      `select kind, text, source_url from policy_chunk
       where brand_id = ? and kind in (${GROUND_TRUTH_KINDS.map(() => '?').join(',')})
       order by kind, rowid`,
    )
    .all(brandId, ...GROUND_TRUTH_KINDS) as { kind: string; text: string; source_url: string }[];

  const byKind = new Map<string, { texts: string[]; sourceUrl: string }>();
  for (const row of rows) {
    const entry = byKind.get(row.kind) ?? { texts: [], sourceUrl: row.source_url };
    entry.texts.push(row.text);
    byKind.set(row.kind, entry);
  }

  const docs: PolicyDoc[] = [];
  let budget = GROUND_TRUTH_CHAR_LIMIT;

  // Shortest documents first, so one sprawling page cannot crowd out the others entirely.
  const ordered = [...byKind.entries()].sort(
    (a, b) => a[1].texts.join(' ').length - b[1].texts.join(' ').length,
  );

  for (const [kind, entry] of ordered) {
    const full = entry.texts.join('\n\n');
    const text = full.slice(0, Math.max(0, budget));
    if (!text) continue;
    budget -= text.length;
    docs.push({ kind, text, sourceUrl: entry.sourceUrl, truncated: text.length < full.length });
  }

  return docs.sort(
    (a, b) => GROUND_TRUTH_KINDS.indexOf(a.kind as never) - GROUND_TRUTH_KINDS.indexOf(b.kind as never),
  );
}
