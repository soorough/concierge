# concierge

Paste a brand's domain. Seconds later you're texting an agent that knows their real
catalog, their real prices, and their real policies, and can hand you a real cart.

- **Spec:** [SPEC.md](SPEC.md)
- **What it supports, and what it does not:** [CAPABILITIES.md](CAPABILITIES.md)
- **Why it's built this way:** [DECISIONS.md](DECISIONS.md)
- **Deploying:** [DEPLOY.md](DEPLOY.md)

## Status

Working end to end against a live Shopify catalog: ingest, agent turns, deterministic
rails, an append-only fact ledger, and a real cart handoff.

- `npm run evals` — 59 deterministic cases, no API key required
- `npm run stress` — 29 adversarial probes against a running agent
- `npm run monitor` — live health against written-down service levels; exits non-zero on a breach
- `npm run restart` — rebuild the console and restart the server, killing by port

## Run

```sh
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY
npm run db:reset
npm run dev
```

## Stack

Node 20+, TypeScript, Fastify, `better-sqlite3` (FTS5), React + Vite console.
Single origin, deployed on Railway with a mounted volume.
