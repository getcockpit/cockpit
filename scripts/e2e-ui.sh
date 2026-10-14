#!/usr/bin/env bash
# UI end-to-end suite (MR-150): starts the demo harness on its own port, then drives every JTBD
# flow headless through PinchTab (scripts/e2e/ui.ts). No Claude, no usage. Exits nonzero on any
# failure, with a screenshot per failed flow. `./scripts/e2e-ui.sh J4` runs only matching flows.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
command -v pinchtab >/dev/null || { echo "pinchtab not found: npm install -g pinchtab"; exit 1; }
[ -d "$root/ui/node_modules" ] || (cd "$root/ui" && bun install --frozen-lockfile >/dev/null)

port="${MR_E2E_PORT:-1539}"
(cd "$root/ui" && exec bun x vite --port "$port" --strictPort --host 127.0.0.1 >/tmp/mr-e2e-vite.log 2>&1) &
vite=$!
session=""
cleanup() {
  kill "$vite" 2>/dev/null || true
  [ -n "$session" ] && pinchtab session revoke "$session" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$port/" >/dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$port/" >/dev/null || { echo "vite did not start:"; cat /tmp/mr-e2e-vite.log; exit 1; }

session="$(pinchtab session create --agent-id mr-e2e 2>/dev/null)"
[[ "$session" == ses_* ]] || { echo "pinchtab session create failed (got '$session'); see the PinchTab notes in CLAUDE.md"; exit 1; }
export PINCHTAB_SESSION="$session" MR_E2E_BASE="http://127.0.0.1:$port"
bun "$root/scripts/e2e/ui.ts" "$@"
