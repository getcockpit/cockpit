#!/usr/bin/env bash
# End-to-end check with real Claude (spends a little usage): without being told, Claude names the
# thread (title_set) and ends its turn with proposed replies on a Next: line (MR-63).
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=title MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit" || true
db="$data/events.sqlite"
echo "--- title"
sqlite3 "$db" "SELECT json_extract(payload,'$.title') FROM events WHERE kind='session.titled';"
echo "--- last reply"
last=$(sqlite3 "$db" "SELECT json_extract(c.value,'$.text') FROM events e, json_each(e.payload,'$.message.message.content') c WHERE json_extract(e.payload,'$.message.type')='assistant' AND json_extract(c.value,'$.type')='text' ORDER BY e.id DESC LIMIT 1;")
echo "$last"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='session.titled'" "Claude never named the thread"
echo "$last" | grep -Eq '^\**Next:?\**:? .*["“][^"”]+["”]' || { echo "FAILED: no Next: line with quoted replies"; exit 1; }
echo "SELFTEST TITLE PASSED ($db)"
