#!/usr/bin/env bash
# End-to-end check with real Claude (spends a little usage): a session starts another with the mr
# session_spawn tool (MR-176); the child runs, names its parent, and isn't offered the tool itself.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=spawn MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit" || true
db="$data/events.sqlite"
echo "--- spawned"
sqlite3 "$db" "SELECT session_id, json_extract(payload,'$.child'), json_extract(payload,'$.cwd') FROM events WHERE kind='session.spawned';"
child=$(sqlite3 "$db" "SELECT json_extract(payload,'$.child') FROM events WHERE kind='session.spawned' LIMIT 1;")
parent=$(sqlite3 "$db" "SELECT session_id FROM events WHERE kind='session.spawned' LIMIT 1;")
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
none() { [ "$(sqlite3 "$db" "$1")" = "0" ] || { echo "FAILED: $2"; exit 1; }; }
[ -n "$child" ] || { echo "FAILED: the parent never spawned a session"; exit 1; }
need "SELECT COUNT(*) FROM events WHERE session_id='$child' AND kind='ui.session_requested' AND json_extract(payload,'$.parent')='$parent'" "the child doesn't name its parent"
need "SELECT COUNT(*) FROM events WHERE session_id='$child' AND json_extract(payload,'$.message.result') LIKE '%CHILD DONE%'" "the child never finished its turn"
tools="json_extract(payload,'$.message.tools')"
need "SELECT COUNT(*) FROM events WHERE session_id='$parent' AND json_extract(payload,'$.message.subtype')='init' AND $tools LIKE '%session_spawn%'" "the parent wasn't offered session_spawn"
none "SELECT COUNT(*) FROM events WHERE session_id='$child' AND json_extract(payload,'$.message.subtype')='init' AND $tools LIKE '%session_spawn%'" "the child was offered session_spawn"
echo "SELFTEST SPAWN PASSED ($db)"
