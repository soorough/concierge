PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brand (
  id TEXT PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL,
  name TEXT,
  currency TEXT,
  logo_url TEXT,
  palette_json TEXT,
  category TEXT,                 -- alcohol | supplement | general
  ingest_path TEXT,              -- shopify | crawl
  detected_sms_vendor TEXT,      -- attentive | postscript | klaviyo | emotive | null
  free_ship_threshold INTEGER,
  restricted_regions_json TEXT,
  products_total INTEGER DEFAULT 0,
  products_excluded INTEGER DEFAULT 0,
  missing_json TEXT,             -- what ingest could not find
  ingested_at INTEGER
);

CREATE TABLE IF NOT EXISTS product (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand(id) ON DELETE CASCADE,
  sku TEXT,
  variant_id TEXT,               -- powers the Shopify cart permalink
  title TEXT NOT NULL,
  price_cents INTEGER,
  currency TEXT,
  available INTEGER DEFAULT 1,
  sellable INTEGER DEFAULT 1,    -- price>0 AND available AND type not denied
  excluded_reason TEXT,
  product_type TEXT,
  tags_json TEXT,
  description TEXT,
  url TEXT,
  image_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_brand ON product(brand_id, sellable);

CREATE VIRTUAL TABLE IF NOT EXISTS product_fts
  USING fts5(title, description, tags_json, content='product', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS policy_chunk (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand(id) ON DELETE CASCADE,
  kind TEXT,                     -- shipping | returns | faq | about | terms
  text TEXT NOT NULL,
  source_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_policy_brand ON policy_chunk(brand_id);

CREATE VIRTUAL TABLE IF NOT EXISTS policy_fts
  USING fts5(text, content='policy_chunk', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS customer (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  display_name TEXT,
  locale TEXT,
  region TEXT,
  age_verified_at INTEGER,
  opted_out_at INTEGER,
  first_seen INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_session ON customer(brand_id, session_id);

CREATE TABLE IF NOT EXISTS turn (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,       -- in | out
  text TEXT,
  payload_json TEXT,             -- cards, buttons
  model TEXT,
  provider TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents REAL,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_customer ON turn(customer_id, created_at);

CREATE TABLE IF NOT EXISTS rail_event (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turn(id) ON DELETE CASCADE,
  level TEXT NOT NULL,           -- pass | warn | block
  code TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_rail_turn ON rail_event(turn_id);

-- append only. never UPDATE a fact's content.
CREATE TABLE IF NOT EXISTS fact (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL,
  source TEXT NOT NULL,          -- conversation (first-party) | field_note (third-party)
  source_turn_id TEXT,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,              -- NULL = currently true
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_fact_current ON fact(customer_id, valid_to);

CREATE TABLE IF NOT EXISTS cart (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'open',
  permalink TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS cart_line (
  cart_id TEXT NOT NULL REFERENCES cart(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  variant_id TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS spend_log (
  day TEXT PRIMARY KEY,
  cost_cents REAL DEFAULT 0
);
