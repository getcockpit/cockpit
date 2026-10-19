#!/usr/bin/env bash
# End-to-end check with real Claude (spends a little usage): a recurring session due a minute from
# now starts by itself, runs, and its finished notification is logged (MR-167).
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=schedule MR_SCHEDULE_TICK_MS=5000 MR_DATA_DIR="$data" perl -e 'alarm 240; exec @ARGV' "$root/src-tauri/target/debug/Cockpit" || true
db="$data/events.sqlite"
echo "--- schedule events"
sqlite3 "$db" "SELECT kind, payload FROM events WHERE kind LIKE 'ui.schedule_%' OR kind LIKE 'schedule.%' OR kind='notify.sent';"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='ui.schedule_set'" "no schedule was saved"
need "SELECT COUNT(*) FROM events WHERE kind='schedule.fired' AND json_extract(payload,'$.reason')='due'" "the schedule never fired"
sid=$(sqlite3 "$db" "SELECT json_extract(payload,'$.session') FROM events WHERE kind='schedule.fired' LIMIT 1;")
need "SELECT COUNT(*) FROM events WHERE kind='ui.session_requested' AND session_id='$sid' AND json_extract(payload,'$.schedule') IS NOT NULL" "the run isn't tagged with its schedule"
need "SELECT COUNT(*) FROM events WHERE kind='sidecar.sdk' AND session_id='$sid' AND json_extract(payload,'$.message.type')='result'" "the run never finished a turn"
need "SELECT COUNT(*) FROM events WHERE kind='notify.sent' AND json_extract(payload,'$.key')='recurring:$sid'" "no finished notification"
[ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='schedule.fired'")" = "1" ] || { echo "FAILED: fired more than once"; exit 1; }
echo "SELFTEST SCHEDULE PASSED ($db)"
