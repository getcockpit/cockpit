#!/usr/bin/env bash
# Move a session between workspaces (MR-154): a Personal session remembers a word, is moved to a new
# workspace mid-turn (queued until the turn ends, MR-177) and back, then resumes and must still remember it. Its conversation is copied into the
# workspace's own Claude folder on the way.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=move MR_DATA_DIR="$data" perl -e 'alarm 240; exec @ARGV' "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
ws="$(ls "$data/workspaces" | head -1)"
sdk="$(sqlite3 "$db" "SELECT json_extract(payload,'$.sdk_session_id') FROM events WHERE kind='sidecar.session_started' ORDER BY id LIMIT 1;")"
moves="$(sqlite3 "$db" "SELECT group_concat(json_extract(payload,'$.to') || ':' || json_extract(payload,'$.copied'), ' ') FROM events WHERE kind='ui.session_moved';")"
[ "$moves" = "$ws:1 personal:1" ] || { echo "FAILED: moves logged as '$moves'"; exit 1; }
queued="$(sqlite3 "$db" "SELECT count(*) FROM events WHERE kind='ui.session_move_queued' AND json_extract(payload,'$.to')='$ws' AND id < (SELECT min(id) FROM events WHERE kind='ui.session_moved');")"
[ "$queued" = 1 ] || { echo "FAILED: the mid-turn move wasn't queued first"; exit 1; }
ls "$data/workspaces/$ws/claude/projects"/*/"$sdk.jsonl" >/dev/null 2>&1 || { echo "FAILED: conversation not copied into $ws"; exit 1; }
last="$(sqlite3 "$db" "SELECT json_extract(payload,'$.workspace') FROM events WHERE kind='ui.session_requested' ORDER BY id DESC LIMIT 1;")"
[ "$last" = "personal" ] || { echo "FAILED: resumed in '$last', not personal"; exit 1; }
answer="$(sqlite3 "$db" "SELECT json_extract(payload,'$.message.result') FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result' ORDER BY id DESC LIMIT 1;")"
echo "moves: $moves"; echo "answer after the moves: $answer"
echo "$answer" | grep -qi pineapple || { echo "FAILED: the moved session forgot the word"; exit 1; }
echo "SELFTEST MOVE PASSED"
