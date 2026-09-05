# What this supports, and what it does not

A plain account of what the agent can answer and do today, what it deliberately refuses,
and what it cannot do yet. Written so nobody has to discover a limit in front of a
customer.

Verified against three deliberately different catalogs — `onehopewine.com` (97 sellable
wines, age-gated, taste-driven), `wolftoothcomponents.com` (310 sellable bike components,
compatibility-driven) and `transparentlabs.com` (68 sellable supplements, claim-sensitive) —
with
`npm run evals` (88 deterministic cases) and `npm run stress` (29 adversarial probes).

Every figure below was measured on **2026-09-04** and `npm run numbers` reprints all of them
from source. Catalogs are live and they move: ONEHOPE was 122 products the day before this
was written and 121 the day after, because they delisted one, and a sellable count changes
whenever something goes out of stock. A number here is true on the day it was measured, not
forever.

---

## Supported

### Ingest

| Capability | Notes |
|---|---|
| Shopify storefronts | `products.json` paginated in full, plus shipping, refund, terms and FAQ pages |
| Brand identity | Name, logo, dominant palette, currency — the thread renders in the brand's own colours |
| Category detection | `alcohol` → age gate and region blocking; `supplement` → health, research and regulatory claims blocked; `general` → neither |
| Incumbent SMS vendor | Attentive, Postscript, Klaviyo, Emotive, Yotpo detected from script tags |
| Sellability filtering | Price, availability and per-brand type denylist. ONEHOPE: 121 products → 97 sellable, 24 excluded |
| Honest gap reporting | Every page it could not find is listed by name and candidate URL |
| Promotions | Percentage and free-shipping offers stated on the brand's site are captured, quotable by the agent, and shown on the checkout card as applying at checkout |
| Preflight classification | `shopify` / `crawl` / `blocked` in about a second, with the bot wall named |
| Caching | Results cached per domain with the ingest timestamp shown and a re-ingest button that genuinely re-runs |
| Schema migration | Columns added after a deployment are applied to the existing database, not only to fresh ones |
| Currency validation | The shop's own currency is read from `/meta.json` and checked against what the storefront served; a mismatch aborts rather than storing wrong prices |
| Multiple brands | Ingested brands are switchable from the console; threads, carts and ledgers stay scoped per brand |

### Conversation

| Capability | Notes |
|---|---|
| Product questions | Prices, styles, tasting notes, availability. Quoted prices and cart writes are read from the live storefront at the moment of use; everything else is reasoned over the ingested catalog |
| Semantic matching | "Something that goes with ribeye", "a gift for my mum who likes sweet things", "what to bring to a beach picnic" |
| Price rankings | "What's your cheapest" answered from a price-ordered catalog, not guessed |
| Multi-turn referents | "Give me that one" resolves against what either side named earlier |
| Policy questions | Shipping, delivery times, returns, refunds, damage, cancellation, signature requirements, minimum order, wine club — answered verbatim from the brand's own pages |
| Shipping eligibility | "Do you ship to Utah?" answered from the brand's real state list |
| Cart | Add, change quantity, remove, live subtotal computed from database prices. Where the store prices the cart, its confirmed lines are compared against ours and a disagreement withholds the checkout card |
| Tool use | Three tools reach what the prompt cannot: the live store's price, the live store's stock, and the `terms` policy text that retrieval excludes from every turn |
| Routed loop | A deterministic router decides per turn whether tools are worth offering. Price, availability, terms, intent to buy, or an open cart get a loop; everything else keeps the single constrained call |
| Tool budget | Three calls per turn (`TOOL_CALL_BUDGET`), named in the prompt so the model paces itself. Calls arrive one at a time, so the model knows what it learned before asking for more; spending the budget without an answer escalates |
| Output shape | A JSON Schema enforces the reply on the loop path, where a prefill cannot go; the single-call path keeps the prefill, which is free and never failed there |
| Trajectory record | Every tool call persisted with its order, arguments, result, provenance and duration, queryable and shown in the console beside that turn's own cost and latency |
| Checkout handoff | The store prices the cart over its own MCP endpoint where available — real totals, named discounts and a genuine checkout URL — falling back to a constructed cart permalink where it is not |
| Storefront MCP | `/api/mcp` tools discovered at ingest and recorded per brand; 3 of 4 brands tested expose cart tools, 1 exposes only policy search |
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
| `PRICE_RESOLVED` | Prices come from the database or the store; the model emits a token |
| `PRICE_LIVE` | The quoted price was read from the live storefront, not the ingest snapshot |
| `PRICE_DRIFT` | The store has repriced since ingest — the live number is quoted and the gap logged. An order-of-magnitude gap quotes neither and escalates |
| `PRICE_STALE` | A live path exists and the store did not answer, so the snapshot was quoted |
| `STOCK_LIVE` | Availability confirmed with the store at cart-write time |
| `STOCK_DRIFT` | The store will not sell it today — nothing is written and the turn escalates |
| `TOOL_CALL` | One step of the turn's trajectory: which tool, with what arguments, live or local, and how long |
| `TOOL_BUDGET_EXHAUSTED` | The model asked for more tool calls than the turn allows — the turn stops and a human is asked, rather than answering half-informed |
| `UNGROUNDED_PRICE` | Any price the model wrote itself, digits or spelled out |
| `UNAUTHORIZED_OFFER` | Inventing a discount. The brand's own stated promotions pass as `OFFER_AUTHORISED` |
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
| Tool use on DeepSeek | The endpoint supports function calling; it has never been run here, so the provider declines it and a DeepSeek turn takes the single constrained call. Every rail still runs |
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
| Live truth on non-Shopify brands | The live price and stock lookup is a Shopify endpoint. A crawled brand prices from the snapshot, and `PRICE_STALE` says so rather than implying a check happened |
| Live lookup outside the warmed set | The four lexically closest products are warmed while the model thinks, so the lookup is free. A reply quoting something outside that set pays roughly 300ms |
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
- **Cart totals are list prices when the store will not price them.** Where a storefront
  exposes `update_cart` the card shows the real total and the discounts by name. Where it
  does not, the subtotal is list price and the card says promotions apply at checkout.
- **A loop turn costs about three times a single-call turn, and takes about twice as long.**
  Measured on ONEHOPE: 0.214¢ and 2,230ms on the single-call path against 0.58–1.24¢ and
  4.1–8.4s with a loop. Two sequential model calls cannot happen inside two seconds. The
  router keeps most traffic on the cheap path and the console shows the difference per turn
  rather than averaging it away, but the `SPEC.md` §3 p50 target describes the single-call
  path only.
- **The router is a set of text patterns, and real customers do not phrase things like test
  cases.** It is deterministic and readable, which is why it was chosen over a model call,
  but it will miss phrasings nobody thought of. The failure is mild rather than dangerous: a
  missed route makes the agent reason over the ingest snapshot, and never makes it quote a
  stale price, because prices are resolved live regardless. Worth watching in the rail log
  rather than assumed correct.
- **A refused cart write escalates after the fact.** Availability is checked with the store
  before the line is written, so a sold-out item never reaches a cart. But the reply has
  already been written by then, so the turn returns the generic escalation sentence rather
  than a reply that reflects what happened.
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
