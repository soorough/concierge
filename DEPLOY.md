# Deploying

Currently live at **https://concierge-production-4b32.up.railway.app**, deployed from
`master` on every push, running in Singapore with a volume mounted at `/data`.

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

`railway.json` and `nixpacks.toml` **are** honoured — the deprecation notice only blocks
services that have never used config-as-code from opting in, and existing files keep working.
The first build log confirms it: the setup phase installs `nodejs_20, python3, gcc, gnumake`
from `nixpacks.toml`, and the build and start commands come from `railway.json`.

Three things learned from the first builds:

- **Do not install twice.** Nixpacks installs in its own phase. A build command that runs
  `npm ci` again wipes `node_modules` and fails against the mounted cache with
  `EBUSY: rmdir '/app/node_modules/.cache'`; one that runs `npm install` instead re-resolves
  the tree and rebuilds native modules — with `gcc` present, `better-sqlite3` compiles from
  source rather than using its prebuilt binary. That single step took **5m 7s**. The install
  phase now carries `--include=dev` and the build phase only builds.
- **`--include=dev` is not optional.** The builder runs in production mode and omits
  devDependencies; `typescript` is one, so `tsc` would not exist at build time.
- **Prune before the image is exported.** `build:deploy` removes the console's dependency
  tree and prunes dev dependencies once the build has produced `dist/` and `console/dist/`.
  Nothing the server needs at runtime is a devDependency, and image size is push time.

| Setting | Value | Why |
|---|---|---|
| Builder | Nixpacks | `nixpacks.toml` adds the toolchain `better-sqlite3` needs to compile |
| Custom Build Command | *leave empty* | `railway.json` supplies it |
| Custom Start Command | *leave empty* | `railway.json` supplies `npm start` |
| Healthcheck Path | *leave empty* | `railway.json` supplies `/api/health`, the only route left open when a password is set |
| Replicas | **1** | SQLite on one volume. A second replica is a second database and a split brain |
| Serverless / scale to zero | **off** | A cold start reloads a native module and loses the prompt cache; the first message after a sleep is slow and expensive |
| Volume | **mount at `/data`** | Without it the database is wiped on every deploy and every ingested brand disappears |
| `DB_PATH` | **`/data/concierge.db`** | Mounting the volume is not enough. If `DB_PATH` is unset the database is written inside the container and erased anyway |
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

Compilation is not the cost. Measured on this repo: `tsc` plus copying the SQL is 1.6s and
the console's Vite build is 1.7s. `better-sqlite3` installs a prebuilt binary in about 27s
rather than compiling — unless something forces a rebuild, which is exactly what the
duplicate install pass did.

From a real build log: `npm ci` 45s, the duplicate install-and-build step **5m 7s**, image
export 13s, and a 476 MB image to push. Removing the duplicate pass and pruning the image is
where the time was.

What is worth controlling:

- **Read the per-step durations in the build log.** They are printed against each step. If
  `npm ci` is the long pole, the registry is the bottleneck; if the Nix `RUN` is, the setup
  image is; if neither, it is layer export and deploy, which this repo does not control.
- **Later builds are faster** because layers cache — but any change to tracked files
  invalidates from the `COPY` onward, so most real deploys will reinstall dependencies.

## Deploy

```sh
npx @railway/cli up          # or just push to the connected branch
```

The build runs `tsc`, copies `store/*.sql` into `dist` — TypeScript does not emit them, and
forgetting this fails at first boot with `ENOENT: schema.sql` — and builds the console. The
server serves the API and the built console from one origin, so there is no CORS surface.

## Checking that storage actually persists

Mounting a volume and pointing the database at it are two separate things, and getting the
second one wrong looks completely healthy — until a deploy quietly takes every ingested brand
and every conversation with it. That happened on the first deploy here.

```sh
curl https://<your-app>.up.railway.app/api/health
```

`storage.persistent` must be `true`. If it is `false` the response says where the database
actually is, the server logs a warning at boot, and the console shows a `NOT PERSISTENT` row
in the operator column. Set `DB_PATH` and redeploy.

## After deploying

```sh
curl https://<your-app>.up.railway.app/api/health

MONITOR_URL=https://<your-app>.up.railway.app \
CONSOLE_PASSWORD=<the password> npm run monitor
```

The monitor and the stress suite both send the console password; without it they only report
that they cannot see anything. Rates are not judged below twenty turns in the window — one
blocked reply out of three is a 33% block rate and means nothing.

`npm run monitor` exits non-zero when a service level is breached, so it is worth putting on
a schedule rather than remembering to run it.

## Before anyone outside the team uses it

`CONSOLE_PASSWORD` gates the API, and the caps bound the spend, but this remains an internal
tool for evaluating and pitching brands. `CAPABILITIES.md` lists what has to exist before it
talks to a real customer — brand authorisation, a human approval mode, and a real messaging
channel with the brand's own credentials.
