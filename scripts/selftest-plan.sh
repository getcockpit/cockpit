#!/usr/bin/env bash
# End-to-end check of plan_set with real Claude (spends a little usage): asked for multi-step work without naming any tool, Claude should publish its plan and update it (MR-62).
# report without naming any tool, Claude should compose it from the catalog (decision 26, MR-61).
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=plan MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
echo "--- plan updates"
sqlite3 "$db" "SELECT id, (SELECT group_concat(json_extract(s.value,'$.status'), ' ') FROM json_each(e.payload,'$.steps') s) FROM events e WHERE kind='plan.updated' ORDER BY id;"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='plan.updated'" "Claude published no plan"
need "SELECT COUNT(*) > 1 FROM events WHERE kind='plan.updated'" "Claude never updated the plan after publishing it"
need "SELECT COUNT(*) FROM events e WHERE kind='plan.updated' AND id=(SELECT MAX(id) FROM events WHERE kind='plan.updated') AND NOT EXISTS (SELECT 1 FROM json_each(e.payload,'$.steps') s WHERE json_extract(s.value,'$.status')!='done')" "the final plan isn't all done"
echo "SELFTEST PLAN PASSED ($db)"
