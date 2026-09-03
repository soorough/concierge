# What this supports, and what it does not

A plain account of what the agent can answer and do today, what it deliberately refuses,
and what it cannot do yet. Written so nobody has to discover a limit in front of a
customer.

Verified against three deliberately different catalogs — `onehopewine.com` (97 sellable
wines, age-gated, taste-driven), `wolftoothcomponents.com` (309 sellable bike components,
compatibility-driven) and `transparentlabs.com` (68 sellable supplements, claim-sensitive) —
with
`npm run evals` (51 deterministic cases) and `npm run stress` (29 adversarial probes).

---

## Supported

### Ingest

| Capability | Notes |
|---|---|
| Shopify storefronts | `products.json` paginated in full, plus shipping, refund, terms and FAQ pages |
| Brand identity | Name, logo, dominant palette, currency — the thread renders in the brand's own colours |
| Category detection | `alcohol` → age gate and region blocking; `supplement` → health, research and regulatory claims blocked; `general` → neither |
| Incumbent SMS vendor | Attentive, Postscript, Klaviyo, Emotive, Yotpo detected from script tags |
| Sellability filtering | Price, availability and per-brand type denylist. ONEHOPE: 122 products → 98 sellable, 24 excluded |
| Honest gap reporting | Every page it could not find is listed by name and candidate URL |
| Preflight classification | `shopify` / `crawl` / `blocked` in about a second, with the bot wall named |
| Caching | Results cached per domain with the ingest timestamp shown and a re-ingest button that genuinely re-runs |
| Currency validation | The shop's own currency is read from `/meta.json` and checked against what the storefront served; a mismatch aborts rather than storing wrong prices |
| Multiple brands | Ingested brands are switchable from the console; threads, carts and ledgers stay scoped per brand |

### Conversation

| Capability | Notes |
|---|---|
| Product questions | Prices, styles, tasting notes, availability — from the live catalog |
| Semantic matching | "Something that goes with ribeye", "a gift for my mum who likes sweet things", "what to bring to a beach picnic" |
| Price rankings | "What's your cheapest" answered from a price-ordered catalog, not guessed |
| Multi-turn referents | "Give me that one" resolves against what either side named earlier |
| Policy questions | Shipping, delivery times, returns, refunds, damage, cancellation, signature requirements, minimum order, wine club — answered verbatim from the brand's own pages |
| Shipping eligibility | "Do you ship to Utah?" answered from the brand's real state list |
| Cart | Add, change quantity, remove, live subtotal computed from database prices |
| Checkout handoff | A real Shopify cart permalink that lands on the brand's own pre-filled cart |
| Age gate | Tappable in-thread confirmation on alcohol brands, gating the checkout card |
| Memory | Durable facts — style, budget, occasion, allergy, gifting — with contradictions superseding rather than duplicating |
| Second source | A rep's field note extracted into the same ledger, outranked by anything the customer says |
| Compliance keywords | STOP, START, HELP handled with fixed strings and no model call |

### Monitoring

| Capability | Notes |
|---|---|
| Live telemetry | `/api/metrics` aggregates turns, model calls, cost, latency percentiles and rail rates over any window up to 30 days |
| Service levels | Five written-down thresholds — escalation rate, blocked rate, recovered-output rate, p95 latency, cost per turn |
| Console health panel | The same figures beside the rail log, refreshed every 30s |
| Scheduled check | `npm run monitor` prints the dashboard and exits non-zero on a breach, so it can run on a cron rather than be remembered |
| Per-brand cost | Spend attributed to the brand that incurred it |

Rail rates are a *safety* signal, not an accuracy one. A turn where no rail fired is a turn
nobody objected to, which is not the same as a turn that was right.

### Guardrails

Every rail below is deterministic and fires whatever the model produced.

| Rail | What it prevents |
|---|---|
| `PRICE_RESOLVED` | Prices come from the database; the model emits a token |
| `UNGROUNDED_PRICE` | Any price the model wrote itself, digits or spelled out |
| `UNAUTHORIZED_OFFER` | Discounts, coupons, promo codes, percentages off |
| `UNGROUNDED_SHIPPING_CLAIM` | Promising delivery to a place no policy mentions |
| `UNGROUNDED_DELIVERY_CLAIM` | Promising a timeframe no policy supports |
| `HEALTH_CLAIM` | Medical, scientific or regulatory assertions — asserted *or denied* |
| `INTERNALS_LEAKED` | Disclosing prompts, rules, tools or the action schema |
| `CART_MISMATCH` | Adding a product other than the one the reply names |
| `CART_UNANNOUNCED` | Adding to cart when the reply never said so |
| `CART_REJECTED` | Acting on a product the model was not shown |
| `NON_SELLABLE_SKU` | Recommending packaging, fees or components |
| `QTY_CLAMPED` / `QTY_INVALID` | Absurd or negative quantities |
| `AGE_REQUIRED` | Checkout on an alcohol brand before age confirmation |
| `REGION_BLOCKED` | Checkout into a restricted region |
| `REF_LEAKED` | Internal catalog numbers reaching the customer |
| `UNVERIFIED_SUPERLATIVE` | Visible warning on ranking claims over a partial catalog |
| `MESSAGE_TOO_LONG` / `RATE_LIMITED` / `SPEND_CAP` | Token-burn and cost exposure, refused before any model call |
| `OUTPUT_RECOVERED` | Non-JSON output degrades to a plain reply, still rail-checked, instead of losing the turn |

### Verified refusals

Confirmed live, each in a fresh session: instruction override, fake `SYSTEM:` authority,
system-prompt extraction, action-schema disclosure, claimed prices, price matching, fake
CEO discounts, age circumvention via a third party, self-certifying age, pregnancy and
health-claim questions, drink-driving, other customers' data, SQL framing, arbitrary code
requests, politics, personal crises, competitor characterisation, invented delivery dates,
non-existent products, and absurd or negative cart quantities.

---

## Not supported

### Deliberately out of scope

| Not supported | Why |
|---|---|
| Real messaging channels | No WhatsApp, iMessage or SMS. The surface is a simulator behind a `Channel` interface; WhatsApp adds Meta's paperwork, iMessage adds Apple approval and a registered provider |
| Payments | The cart is real and the handoff is real, but money moves on the brand's own site. No card is processed here |
| Order lookup | No order status, tracking numbers or account history — there is no commerce backend connection |
| Authentication | A shared console password only. No accounts, roles or organisations |
| Multi-brand workspaces | Brands are isolated by row, not by tenant |
| Outbound messaging | The agent only replies. No campaigns, no re-engagement, no scheduling |
| Vector search | Lexical retrieval plus a full-catalog prompt. Justified in `DECISIONS.md` §1 |

### Not built yet

**Accuracy in production is not measured.** The monitor answers "is the system behaving" —
cost, latency, how often rails fire, whether the model is returning usable output. It does
not answer "were the answers correct". That needs one of: a judge model over sampled turns,
a golden set replayed on a schedule against the live config, or human review of a sample.
`npm run stress` is the closest thing and it runs only when invoked.

Other gaps:

| Gap | Consequence |
|---|---|
| Crawl adapter | Non-Shopify brands classify as `crawl` and then stop. Only Shopify ingests end to end |
| WAF-protected sites | Summit Racing, CarID, FCP Euro and McMaster are refused by design, with the wall named |
| Catalogs over ~400 products | Falls back to a lexical slice, and semantic matching degrades accordingly |
| Headless and custom storefronts | Not covered by either adapter |
| Non-English brands | Untested. Ingest, tokenisation and rails all assume English |
| Policy pages beyond four | Only shipping, refund, terms and FAQ are fetched; brands with a wider help centre lose the rest |
| Currency conversion | The brand's own currency is detected, validated and rendered, but never converted for the viewer |
| Deployment | Runs locally. Railway configuration and a live URL are still outstanding |
| Alerting | The monitor exits non-zero; nothing routes that anywhere |
| Metrics retention | Derived from the turn table, so history lives as long as the database does; no rollups |

### Known weaknesses

Things that work but are not solid, listed so they are not discovered by a customer.

- **Arithmetic over policy.** Asked how many states it ships to, the agent has answered
  both "43" and "44" in different turns. The list is ground truth; the count is the model
  counting, and nothing checks it.
- **Derived delivery estimates.** "1–3 days processing plus 3–7 days shipping, so roughly
  6–10 business days" is arithmetic, not policy. The delivery rail checks that the numbers
  appear in the policy text, which a derived figure can satisfy coincidentally.
- **Escalation text is generic.** A rail-blocked reply always returns the same sentence
  regardless of which rail fired, even though the rail knows why.
- **Region blocking needs a known region.** `REGION_BLOCKED` only fires when the customer's
  region is recorded. Nothing asks for it, so in practice shipping eligibility is answered
  from policy text rather than enforced at checkout.
- **Sellability is a denylist.** Per-brand configuration, not a classifier. A brand with
  unusual `product_type` conventions will need its list adjusted.
- **The fact ledger grows without bound.** Correct by design, but there is no compaction.
- **Prompt caching has a floor.** Below roughly 2,000 tokens nothing caches, so very small
  catalogs pay full price per turn.

---

## Before a real customer sees this

Ordered by how much it matters.

1. **Brand authorisation.** The agent speaks with a brand's name and quotes their real
   prices. Today that is defensible because it is an internal tool for evaluating and
   pitching brands. It stops being defensible the moment it talks to a shopper.
2. **A human approval mode.** Someone signs off before the agent quotes a price or makes a
   policy commitment to a real customer.
3. **A real channel** with the brand's own credentials, entered per workspace rather than
   hardcoded.
4. **Auth beyond a shared password**, and per-brand isolation that survives more than one
   team using it.
5. **Escalation that reaches somebody.** Escalations are recorded; nothing routes them.
