#!/usr/bin/env bash
# End-to-end check of the Address flow with real Claude (spends a little usage): every thread is
# drawn before the turn stops (MR-126), then picks are fixed and the flow wraps up with next steps.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=address MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
sqlite3 "$db" "SELECT kind, COUNT(*) FROM events WHERE kind LIKE 'flow.%' OR kind LIKE 'ui.address%' GROUP BY kind ORDER BY MIN(id);"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
first_result="$(sqlite3 "$db" "SELECT MIN(id) FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result';")"
need "SELECT COUNT(*) FROM events WHERE kind='flow.address_threads'" "no thread list"
need "SELECT COUNT(DISTINCT json_extract(payload,'$.id'))>=3 FROM events WHERE kind='flow.address_thread' AND id < '$first_result'" "Claude stopped before drawing every thread"
need "SELECT COUNT(*) FROM events WHERE kind='flow.address_fixing'" "no address_fixing for a pick"
need "SELECT COUNT(*) FROM events WHERE kind='flow.address_done' AND json_array_length(json_extract(payload,'$.next'))>=1" "no wrap-up with next steps"
echo "SELFTEST ADDRESS PASSED"
