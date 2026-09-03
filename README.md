# concierge

Paste a brand's domain. Seconds later you're texting an agent that knows their real
catalog, their real prices, and their real policies, and can hand you a real cart.

- **Spec:** [SPEC.md](SPEC.md)
- **Why it's built this way:** [DECISIONS.md](DECISIONS.md)

## Status

Early. Schema, sellability filter, and FTS5 retrieval verified against a live catalog.

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
