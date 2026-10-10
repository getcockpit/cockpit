#!/usr/bin/env bash
# End-to-end check of worktrees + resume with real Claude (spends a little usage): a blank session in
# a git repo gets its own worktree; it is stopped and resumed with the same id and must remember a word.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=resume MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
branch="$(sqlite3 "$db" "SELECT json_extract(payload,'$.branch') FROM events WHERE kind='ui.session_requested' ORDER BY id LIMIT 1;")"
wt="$(sqlite3 "$db" "SELECT json_extract(payload,'$.worktree') FROM events WHERE kind='ui.session_requested' ORDER BY id LIMIT 1;")"
[ -n "$branch" ] && [ -d "$wt" ] || { echo "FAILED: no worktree ($branch, $wt)"; exit 1; }
sessions="$(sqlite3 "$db" "SELECT COUNT(DISTINCT session_id) FROM events WHERE kind='ui.session_requested';")"
[ "$sessions" = "1" ] || { echo "FAILED: resume created a new session id"; exit 1; }
last="$(sqlite3 "$db" "SELECT json_extract(payload,'$.message.result') FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result' ORDER BY id DESC LIMIT 1;")"
echo "worktree: $wt ($branch)"; echo "answer after resume: $last"
echo "$last" | grep -qi pineapple || { echo "FAILED: resumed session forgot the word"; exit 1; }
echo "SELFTEST RESUME PASSED"
