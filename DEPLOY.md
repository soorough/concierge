# Deploying

Railway, because the app keeps a SQLite file on disk and that is the reason it is small
enough to reason about. Everything below assumes the repo at `soorough/concierge`.

## Why not Vercel

Vercel has no persistent disk, so SQLite cannot live there. The alternative is Turso —
SQLite over HTTP, which keeps the schema and FTS5 — but its client is **asynchronous**, and
this codebase has 73 synchronous `.prepare()` calls across 15 files. Every one of them, and
every function that calls them, becomes `async`. That is a multi-hour refactor with real
regression risk, and it buys nothing this app needs: the only long-running work is ingest,
which streams over SSE and finishes in seconds.

If Vercel ever becomes a requirement, the migration is: swap `better-sqlite3` for
`@libsql/client`, make the store layer async, and thread it outward. The schema and every
query survive unchanged.

## Railway dashboard settings

Config-as-code is deprecated and cannot be enabled on new services, so `railway.json` and
`nixpacks.toml` in this repo are ignored — the builder is Railpack and these values come
from the dashboard.

| Setting | Value | Why |
|---|---|---|
| Builder | Railpack (default) | Picks up `npm run build` and `npm start` from package.json |
| Custom Build Command | *leave empty* | The root build compiles the server, copies the SQL, and installs and builds the console |
| Custom Start Command | `npm start` | Runs the compiled server |
| Healthcheck Path | `/api/health` | The only route left open when a password is set |
| Replicas | **1** | SQLite on one volume. A second replica is a second database and a split brain |
| Serverless / scale to zero | **off** | A cold start reloads a native module and loses the prompt cache; the first message after a sleep is slow and expensive |
| Volume | **mount at `/data`** | Without it the database is wiped on every deploy and every ingested brand disappears |
| Region | note it | The storefront prices in the *server's* market — see below |

### The region matters more than it looks

Shopify prices in the market it geolocates the caller to. Deployed in Singapore, a US
storefront may serve SGD, exactly as it served INR from India during development. Ingest
suppresses `Accept-Language` to ask for the shop's own market and then validates the served
currency against `/meta.json`, aborting rather than storing wrong figures. After the first
deploy, re-ingest a brand and confirm the console shows `USD` — a currency mismatch shows up
as a refused ingest, not as silently wrong prices.

## What you have to do yourself

These need your credentials, so they are yours to run, not mine:

1. `npx @railway/cli login` — opens a browser
2. Create the project and link it: `npx @railway/cli init` then `npx @railway/cli link`
3. Add a **volume** mounted at `/data` (Railway dashboard → service → Variables → Volumes).
   Without it the database is wiped on every deploy.
4. Set the variables below

Or connect the GitHub repo from the Railway dashboard, which does 1–2 for you and redeploys
on every push.

## Variables

| Variable | Value | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` | your key | The turn path |
| `DB_PATH` | `/data/concierge.db` | Must point inside the mounted volume |
| `CONSOLE_PASSWORD` | something long | Without it the API is open, and it spends your credits |
| `PORT` | leave unset | Railway injects it |
| `DAILY_SPEND_CAP_CENTS` | `500` | Ceiling for the whole deployment, per UTC day |
| `SESSION_TURN_CAP` | `40` | Per-conversation limit |
| `MAX_MESSAGE_CHARS` | `2000` | Refused before any model call |
| `MODEL_PROVIDER` / `MODEL_NAME` | `anthropic` / `claude-haiku-4-5-20251001` | Defaults if unset |
| `DEEPSEEK_API_KEY` | optional | Only if you switch providers |

## Build time

Expect roughly 4–5 minutes for a cold build: `better-sqlite3` is a native module and is
compiled from source, which took 3m27s from a clean clone locally. Subsequent deploys reuse
the cache and are much faster.

## Deploy

```sh
npx @railway/cli up          # or just push to the connected branch
```

The build runs `tsc`, copies `store/*.sql` into `dist` — TypeScript does not emit them, and
forgetting this fails at first boot with `ENOENT: schema.sql` — and builds the console. The
server serves the API and the built console from one origin, so there is no CORS surface.

## After deploying

```sh
curl https://<your-app>.up.railway.app/api/health
MONITOR_URL=https://<your-app>.up.railway.app npm run monitor
```

`npm run monitor` exits non-zero when a service level is breached, so it is worth putting on
a schedule rather than remembering to run it.

## Before anyone outside the team uses it

`CONSOLE_PASSWORD` gates the API, and the caps bound the spend, but this remains an internal
tool for evaluating and pitching brands. `CAPABILITIES.md` lists what has to exist before it
talks to a real customer — brand authorisation, a human approval mode, and a real messaging
channel with the brand's own credentials.
