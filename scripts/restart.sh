#!/usr/bin/env bash
# Restart the dev server. Killing by port rather than by process pattern, because
# `pkill -f tsx` leaves the npm wrapper alive often enough that you end up testing
# stale code and believing the results.
set -euo pipefail
PORT="${PORT:-3000}"
lsof -ti "tcp:${PORT}" | xargs -r kill -9 2>/dev/null || true
npm --prefix console run build
PORT="$PORT" exec npx tsx server/index.ts
