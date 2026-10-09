#!/usr/bin/env bash
# End-to-end terminal handoff with real Claude: a session hands over to `claude --resume` in a PTY,
# the test types /exit, and the conversation comes back to the app with its memory intact.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=terminal MR_DATA_DIR="$data" perl -e 'alarm 240; exec @ARGV' "$root/src-tauri/target/debug/minority-report" || true
db="$data/events.sqlite"
sqlite3 "$db" "SELECT kind, COUNT(*) FROM events WHERE kind LIKE 'ui.terminal%' OR kind='ui.session_requested' GROUP BY kind ORDER BY MIN(id);"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='ui.terminal_opened'" "terminal never opened"
need "SELECT COUNT(*) FROM events WHERE kind='ui.terminal_closed'" "terminal never closed after /exit"
need "SELECT COUNT(*) FROM events WHERE kind='ui.session_requested' AND json_extract(payload,'$.resume') IS NOT NULL" "session was not handed back"
echo "SELFTEST TERMINAL PASSED"
