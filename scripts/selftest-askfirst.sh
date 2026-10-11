#!/usr/bin/env bash
# End-to-end check with real Claude (spends a little usage): Ask me first on a question card (I75)
# makes Claude ask clarifying questions (on a card or in prose), then offer the choice again.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=askfirst MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit" || true
db="$data/events.sqlite"
echo "--- questions Claude asked"
sqlite3 "$db" "SELECT e.id, json_extract(q.value,'$.question') FROM events e, json_each(e.payload,'$.input.questions') q WHERE e.kind='sidecar.permission_request' AND json_extract(e.payload,'$.tool')='AskUserQuestion' ORDER BY e.id;"
echo "--- replies sent for prose questions"
sqlite3 "$db" "SELECT text FROM (SELECT json_extract(payload,'$.text') AS text FROM events WHERE kind='ui.message_sent') WHERE text LIKE 'Keep it simple%';"
asks=$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='sidecar.permission_request' AND json_extract(payload,'$.tool')='AskUserQuestion';")
prose=$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='ui.message_sent' AND json_extract(payload,'$.text') LIKE 'Keep it simple%';")
[ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='ui.permission_answered' AND json_extract(payload,'$.decision.message') LIKE 'None of these options fit.%';")" = "1" ] || { echo "FAILED: Ask me first wasn't sent"; exit 1; }
# Clarified on a card (a 3rd ask: clarify, then the choice again) or in prose (a reply, then the choice again).
[ "$asks" -ge 3 ] || { [ "$prose" -ge 1 ] && [ "$asks" -ge 2 ]; } || { echo "FAILED: asks=$asks prose replies=$prose (expected clarifying questions, then the choice again)"; exit 1; }
dir="$(sqlite3 "$db" "SELECT json_extract(payload,'$.cwd') FROM events WHERE kind='ui.session_requested' LIMIT 1;")"
ls "$dir"/selftest-*.txt >/dev/null 2>&1 || { echo "FAILED: Claude never finished after clarifying"; ls "$dir"; exit 1; }
echo "asks=$asks prose replies=$prose picked: $(ls "$dir" | grep selftest-)"
echo "SELFTEST ASKFIRST PASSED ($db)"
