#!/usr/bin/env bash
# End-to-end check through the real app binary, sidecar and claude (spends a little usage):
# starts a session, approves its Write, waits for the result, then inspects the event log.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=1 MR_DATA_DIR="$data" "$root/src-tauri/target/debug/minority-report"
db="$data/events.sqlite"
echo "--- event kinds recorded"
sqlite3 "$db" "SELECT kind, COUNT(*) FROM events GROUP BY kind ORDER BY MIN(id);"
need() { sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='$1';" | grep -qv '^0$' || { echo "MISSING: $1"; exit 1; }; }
for k in sidecar.ready ui.session_requested sidecar.session_started sidecar.permission_request ui.permission_answered sidecar.sdk; do need "$k"; done
dir="$(sqlite3 "$db" "SELECT json_extract(payload,'$.cwd') FROM events WHERE kind='ui.session_requested' LIMIT 1;")"
[ -f "$dir/selftest-beta.txt" ] || { echo "MISSING: $dir/selftest-beta.txt (the answer did not reach Claude)"; ls "$dir"; exit 1; }
echo "SELFTEST PASSED ($db)"
