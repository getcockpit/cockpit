#!/usr/bin/env bash
# End-to-end check of the visual Review flow tools with real Claude (spends a little usage).
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=flow MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
sqlite3 "$db" "SELECT kind, COUNT(*) FROM events WHERE kind LIKE 'flow.%' OR kind LIKE 'ui.review%' GROUP BY kind ORDER BY MIN(id);"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='flow.review_overview' AND json_array_length(json_extract(payload,'$.nodes'))>=1" "no overview with nodes"
need "SELECT COUNT(*) FROM events WHERE kind='flow.review_snippet' AND json_extract(payload,'$.findings[0].id')='f1'" "no snippet with finding f1"
need "SELECT COUNT(*) FROM events WHERE kind='flow.review_publish_ready'" "no publish-ready step after the note"
first_result="$(sqlite3 "$db" "SELECT MIN(id) FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result';")"
need "SELECT COUNT(*) FROM events WHERE kind='flow.review_snippet' AND id < '$first_result'" "Claude did not stop after the snippet"
echo "SELFTEST FLOW PASSED"
