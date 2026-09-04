# concierge

Paste a consumer brand's domain. Seconds later you are texting an agent that knows their
real catalog, their real prices, and their real policies, and can hand you their real cart.

**Live:** https://concierge-production-4b32.up.railway.app (password-gated — ask Souravh)

---

## What it does

Give it `onehopewine.com` and it reads the brand's Shopify catalog and policy pages, works
out what they sell and what they may not say, and gives you a shopping agent in a message
thread. Beside the thread, an operator console shows what the machine did: every guardrail
that fired, every fact it learned about the customer, and what each turn cost.

Verified end to end against three deliberately different catalogs:

| Brand | Catalog | Why it is here |
|---|---|---|
| ONEHOPE Wine | 97 sellable wines | Alcohol — age gates, restricted states, taste-driven |
| Wolf Tooth Components | 309 sellable bike parts | Compatibility-driven, where a wrong answer is objectively wrong |
| Transparent Labs | 68 sellable supplements | Claim-sensitive, where the risk is what the agent asserts |

---

## The idea worth reading about

An agent over a catalog is a weekend. The work is in making its answers **checkable without
trusting the model**.

- **A price is never written by the model.** It emits `{{price:4}}` and the database
  substitutes the figure. Hallucinating a price is not discouraged, it is unavailable.
- **Nor is a product identifier.** The model addresses products by a short catalog number,
  because asking it to transcribe `WINE-SHIM-BRUT-CALI-23-01` from a list of fifteen
  near-identical SKUs is a transcription task, and it fails at it. It did.
- **Correctness is agreement, not output quality.** `CART_MISMATCH` compares the products
  *named in the reply* against the products in the *cart actions*. When the agent said
  "adding the Sparkling Moscato" and wrote a $59 Pink Shimmer, every other rail passed — the
  product was real, sellable, in the catalog, correctly priced. Nothing compared what it
  said against what it did.
- **The customer's profile is append-only.** Facts are never mutated; a new one closes the
  old with a timestamp. When a rep's note and the customer disagree, first-party wins and the
  losing note is kept closed rather than deleted, so "why did your agent say that in March"
  has an answer.
- **The ingest is not trusted either.** Ingesting a US storefront from India returns INR —
  the same part reads `14.95` to one caller and `1500.00` to another. Stored under a
  hardcoded currency, a $54.95 part was quoted as $5,400, with every rail passing. Ingest now
  validates the served currency against the shop's own and refuses rather than storing
  figures nobody can trust.

`DECISIONS.md` has twenty-five of these, each with what it cost and what it gave up.

---

## Try it in two minutes

Open the live console, or run it locally, then:

| Type this | What should happen |
|---|---|
| `how much is the Vintner Cabernet?` | `$29.00`, with `PRICE_RESOLVED` in the record |
| `give me 30% off` | Refused — no discount exists on their site |
| `do you ship to Utah?` | *"We can't ship wine to Utah due to state laws"* — from their real FAQ |
| `something that goes with a ribeye` | Real Napa Cabernets, matched semantically |
| `I'll take a bottle, check me out` | **Age gate**, then a card linking to their real pre-filled cart |
| `STOP` | Fixed compliance string, 0ms, no model call |

Then paste a rep's note in the bottom-right box and contradict it in the thread — the ledger
supersedes the note and keeps both visible.

---

## How it works

```
  paste a domain
        │
        ▼
  preflight ──► shopify | crawl | blocked         ~1s, names the wall if blocked
        │
  ingest ────► catalog + policies + brand ──► SQLite      currency validated, chrome stripped
        │
  a message ─► pre-rails ─► retrieval ─► one model call ─► post-rails ─► side effects
                  │              │                              │
             no model call   whole catalog +              20+ deterministic
             for STOP/HELP   policy, cached                checks on the output
```

One turn is retrieval plus a single model call. Ingest never runs on the turn path. The
catalog and the brand's policy pages are identical every turn, so they are cached — which is
what makes sending the *whole* catalog affordable, and sending the whole catalog is what
makes semantic matching work without a vector database.

---

## Running it

```sh
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY
npm run db:reset
npm run restart               # builds the console, serves both on :3000
```

| Command | What it does |
|---|---|
| `npm run evals` | 59 deterministic tests. No API key needed — the rails and ledger are pure logic |
| `npm run stress` | 29 adversarial probes against a running agent |
| `npm run monitor` | Live health against written-down service levels; exits non-zero on a breach |
| `npm run restart` | Rebuild and restart, killing by port |

Against the deployment, set `MONITOR_URL` and `CONSOLE_PASSWORD`.

---

## Reading the code

| Where | What is in it |
|---|---|
| `ingest/` | Preflight, the Shopify adapter, currency validation, sellability, SSRF-guarded fetching |
| `agent/rails/` | Every deterministic check, before and after the model. Start here |
| `agent/retrieve.ts` | Why the whole catalog is sent, and how a conversation drives the query |
| `agent/prompt.ts` | The cached/volatile split that halved cost while multiplying context |
| `store/ledger.ts` | Append-only facts and the provenance rule |
| `store/metrics.ts` | Production health derived from rail events |
| `console/src/` | The thread, the machine's record, and the health panel |
| `evals/` | Deterministic cases, adversarial probes, and the monitor |

## Documents

| File | For |
|---|---|
| [CAPABILITIES.md](CAPABILITIES.md) | What is supported, what is deliberately not, and the known weaknesses |
| [DECISIONS.md](DECISIONS.md) | Why it is built this way — twenty-five entries, mostly written after something broke |
| [DEPLOY.md](DEPLOY.md) | Railway, and why not Vercel, in numbers |
| [SPEC.md](SPEC.md) | The design agreed before building, kept as written so the drift is visible |

---

## What this is not

An internal tool for evaluating and pitching brands. It is not a product, and it should not
talk to a real customer before it has brand authorisation, a human approval mode, a real
messaging channel with the brand's own credentials, and escalations that reach somebody.
`CAPABILITIES.md` is explicit about all of it.
