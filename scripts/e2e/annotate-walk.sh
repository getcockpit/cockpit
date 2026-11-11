#!/bin/sh
# "Annotate a page" walked headless, with a screenshot per step: the real Cockpit browser launch
# path and core model (`ux_walk_host`), driven by trusted input (annotate-walk/drive.ts).
# Usage: scripts/e2e/annotate-walk.sh [out dir]. Needs Chrome (or MR_BROWSER).
set -e
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
OUT="${1:-$(mktemp -d /tmp/mr-annotate-walk-XXXX)}"; mkdir -p "$OUT"
export MR_WALK_DIR="$(mktemp -d /tmp/mr-walk-host-XXXX)"
python3 -I -m http.server 18766 --bind 127.0.0.1 --directory scripts/e2e/annotate-walk >/dev/null 2>&1 & HTTP=$!
(cd src-tauri && cargo test -q --lib ux_walk_host -- --ignored --nocapture >"$MR_WALK_DIR/host.log" 2>&1) & HOST=$!
trap 'touch "$MR_WALK_DIR/done"; kill $HTTP 2>/dev/null; wait $HOST 2>/dev/null' EXIT
while [ ! -e "$MR_WALK_DIR/ready" ]; do sleep 1; kill -0 $HOST 2>/dev/null || { tail -30 "$MR_WALK_DIR/host.log"; exit 1; }; done
perl -e 'alarm 120; exec @ARGV' bun scripts/e2e/annotate-walk/drive.ts "$OUT"
[ -e "$MR_WALK_DIR/data/sent.txt" ] && cp "$MR_WALK_DIR/data/sent.txt" "$OUT/" ; [ -e "$MR_WALK_DIR/sent.txt" ] && cp "$MR_WALK_DIR/sent.txt" "$OUT/"
echo "screens: $OUT"
