#!/usr/bin/env bash
# End-to-end check of working docs with real Claude (spends a little usage): Claude builds a doc via
# the mr tools; the test decides its question, adds a note and sends Regenerate; Claude revises it.
# Then Build from this doc (MR-118): a new session, linked to the doc, reads it and logs to it.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=doc MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
echo "--- doc events"
sqlite3 "$db" "SELECT kind, COUNT(*) FROM events WHERE kind LIKE 'doc.%' OR kind LIKE 'ui.doc%' GROUP BY kind ORDER BY MIN(id);"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='doc.created'" "Claude created no doc"
need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND json_extract(payload,'$.section')='question'" "no question block"
need "SELECT COUNT(*) FROM events WHERE kind='doc.regenerated'" "no regenerate"
need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND json_extract(payload,'$.section')='log'" "Claude added no [log] block after Regenerate"
need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND id > (SELECT MIN(id) FROM events WHERE kind='doc.regenerated') AND json_extract(payload,'$.block_id')='goal'" "Claude did not revise the goal block after the note"
plan="(SELECT session_id FROM events WHERE kind='doc.created' LIMIT 1)"
build="(SELECT session_id FROM events WHERE kind='ui.doc_build_started' LIMIT 1)"
need "SELECT COUNT(*) FROM events WHERE kind='ui.doc_build_started' AND session_id IS NOT $plan" "Build wasn't linked to a new session"
need "SELECT COUNT(*) FROM events WHERE kind='sidecar.tool_call' AND session_id = $build AND json_extract(payload,'$.tool')='doc_read'" "the build session didn't read the doc"
need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND session_id = $build AND json_extract(payload,'$.block_id')='build_log'" "the build session didn't log to the doc"
echo "SELFTEST DOC PASSED ($db)"
