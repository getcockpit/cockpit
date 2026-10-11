#!/usr/bin/env bash
# End-to-end check with real Claude (spends a little usage): Skip on a question card (I75) declines
# it, and Claude carries on with its own pick instead of asking again.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=skip MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit" || true
db="$data/events.sqlite"
echo "--- last reply"
sqlite3 "$db" "SELECT json_extract(c.value,'$.text') FROM events e, json_each(e.payload,'$.message.message.content') c WHERE json_extract(e.payload,'$.message.type')='assistant' AND json_extract(c.value,'$.type')='text' ORDER BY e.id DESC LIMIT 1;"
asks=$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='sidecar.permission_request' AND json_extract(payload,'$.tool')='AskUserQuestion';")
[ "$asks" = "1" ] || { echo "FAILED: Claude asked $asks times (expected once, then carry on)"; exit 1; }
[ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='ui.permission_answered' AND json_extract(payload,'$.decision.behavior')='deny';")" = "1" ] || { echo "FAILED: the question wasn't skipped"; exit 1; }
dir="$(sqlite3 "$db" "SELECT json_extract(payload,'$.cwd') FROM events WHERE kind='ui.session_requested' LIMIT 1;")"
ls "$dir"/selftest-*.txt >/dev/null 2>&1 || { echo "FAILED: Claude stopped instead of carrying on"; ls "$dir"; exit 1; }
echo "picked: $(ls "$dir" | grep selftest-)"
echo "SELFTEST SKIP PASSED ($db)"
