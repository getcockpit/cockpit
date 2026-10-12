#!/usr/bin/env bash
# End-to-end check of Catch me up mid-turn (MR-116): while the session runs a long command, Catch me
# up goes to the Cockpit layer, not the busy session. With a Cockpit key (Keychain or
# MR_COCKPIT_API_KEY) the layer writes the brief's blocks and meters the call; without one the doc
# gets a log block saying why, and brief.failed is logged. Spends a little usage either way.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=brieflayer MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
echo "--- brief events"
sqlite3 "$db" "SELECT kind, COUNT(*) FROM events WHERE kind LIKE 'doc.%' OR kind LIKE 'ui.brief%' OR kind LIKE 'brief.%' OR kind='cockpit.usage' GROUP BY kind ORDER BY MIN(id);"
sqlite3 "$db" "SELECT json_extract(payload,'$.section'), json_extract(payload,'$.takeaway') FROM events WHERE kind='doc.block_set';"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='ui.brief_requested' AND json_extract(payload,'$.via')='cockpit'" "the mid-turn brief didn't go to the Cockpit layer"
need "SELECT COUNT(*) FROM events WHERE kind='doc.created' AND json_extract(payload,'$.kind')='brief'" "no brief doc"
[ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='ui.message_sent' AND json_extract(payload,'$.text') LIKE '%catch-up brief%'")" = "0" ] || { echo "FAILED: the busy session was asked to write the brief"; exit 1; }
if [ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='brief.written'")" != "0" ]; then
  need "SELECT COUNT(*) FROM events WHERE kind='cockpit.usage' AND json_extract(payload,'$.purpose')='brief' AND json_extract(payload,'$.ok')=1" "the layer call wasn't metered"
  need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND json_extract(payload,'$.section')='goal'" "the layer's brief has no 'where we are' block"
  need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND json_extract(payload,'$.section')='risk'" "the layer's brief has no risk block"
  echo "SELFTEST BRIEFLAYER PASSED: written by the layer ($db)"
else
  need "SELECT COUNT(*) FROM events WHERE kind='brief.failed'" "neither brief.written nor brief.failed"
  need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND json_extract(payload,'$.block_id')='failed'" "a failed brief left the doc empty"
  echo "SELFTEST BRIEFLAYER PASSED: no key, failure shown in the doc ($(sqlite3 "$db" "SELECT json_extract(payload,'$.error') FROM events WHERE kind='brief.failed'")) ($db)"
fi
