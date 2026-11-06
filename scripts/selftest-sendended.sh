#!/usr/bin/env bash
# End-to-end check of a restored session taking a message (MR-197), with real Claude (spends a little
# usage): a session is stopped, archived and restored, then sent a message the way the message box
# sends it (session_send, not an explicit resume). It must resume the same conversation and remember a word.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=sendended MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
q() { sqlite3 "$db" "$1"; }
[ "$(q "SELECT COUNT(DISTINCT session_id) FROM events WHERE kind IN ('ui.session_requested','ui.message_sent');")" = "1" ] || { echo "FAILED: the message went to a new session id"; exit 1; }
[ "$(q "SELECT COUNT(*) FROM events WHERE kind='ui.message_sent' AND id > (SELECT id FROM events WHERE kind='ui.session_unarchived');")" = "1" ] || { echo "FAILED: no message sent after the restore"; exit 1; }
[ "$(q "SELECT COUNT(*) FROM events WHERE kind='sidecar.session_started';")" = "2" ] || { echo "FAILED: the ended session wasn't started again"; exit 1; }
sdk="$(q "SELECT COUNT(DISTINCT json_extract(payload,'$.sdk_session_id')) FROM events WHERE kind='sidecar.session_started';")"
last="$(q "SELECT json_extract(payload,'$.message.result') FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result' ORDER BY id DESC LIMIT 1;")"
echo "Claude session ids: $sdk"; echo "answer after the restore: $last"
echo "$last" | grep -qi pineapple || { echo "FAILED: the restored session forgot the word"; exit 1; }
echo "SELFTEST SENDENDED PASSED"
