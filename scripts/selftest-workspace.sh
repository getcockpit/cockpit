#!/usr/bin/env bash
# Workspace isolation: a session in a new workspace runs Claude Code against that workspace's own
# config folder (so it's not signed in yet), with the user's shared files linked in.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=workspace MR_DATA_DIR="$data" perl -e 'alarm 120; exec @ARGV' "$root/src-tauri/target/debug/Cockpit"
ws="$(ls "$data/workspaces" | head -1)"
cfg="$data/workspaces/$ws/claude"
[ -L "$cfg/CLAUDE.md" ] || [ ! -e "$HOME/.claude/CLAUDE.md" ] || { echo "FAILED: CLAUDE.md not linked"; exit 1; }
[ ! -e "$cfg/history.jsonl" ] || [ ! -L "$cfg/history.jsonl" ] || { echo "FAILED: history shared"; exit 1; }
[ "$(sqlite3 "$data/events.sqlite" "SELECT json_extract(payload,'$.workspace') FROM events WHERE kind='ui.session_requested' LIMIT 1;")" = "$ws" ] || { echo "FAILED: session not tagged with its workspace"; exit 1; }
# Same env map as CLAUDE_CONFIG_DIR above, so the session also got the compaction window (I63).
[ "$(sqlite3 "$data/events.sqlite" "SELECT json_extract(payload,'$.compact_window') FROM events WHERE kind='ui.session_requested' LIMIT 1;")" = "200000" ] || { echo "FAILED: compaction window not set"; exit 1; }
ls -la "$cfg" | grep -E -- '->' | awk '{print $9, $10, $11}'
echo "SELFTEST WORKSPACE PASSED ($ws)"
