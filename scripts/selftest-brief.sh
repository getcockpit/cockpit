#!/usr/bin/env bash
# End-to-end check of Catch me up (MR-116) with real Claude (spends a little usage): a turn claims
# tests pass without running any; Catch me up has the session's own Claude write a brief doc; the
# test marks the first risk wrong with a note, the rest fine, and Continue resumes the same session.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=brief MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
echo "--- brief events"
sqlite3 "$db" "SELECT kind, COUNT(*) FROM events WHERE kind LIKE 'doc.%' OR kind LIKE 'ui.doc%' OR kind LIKE 'ui.brief%' OR kind LIKE 'brief.%' GROUP BY kind ORDER BY MIN(id);"
echo "--- brief blocks"
sqlite3 "$db" "SELECT json_extract(payload,'$.section'), json_extract(payload,'$.takeaway') FROM events WHERE kind='doc.block_set';"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='ui.brief_requested' AND json_extract(payload,'$.via')='session'" "the brief didn't go to the session's own Claude"
need "SELECT COUNT(*) FROM events WHERE kind='doc.created' AND json_extract(payload,'$.kind')='brief'" "no brief doc"
need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND json_extract(payload,'$.section')='goal'" "the brief has no 'where we are' block"
need "SELECT COUNT(*) FROM events WHERE kind='doc.block_set' AND json_extract(payload,'$.section')='risk'" "the brief flagged nothing (the turn claimed tests it never ran)"
need "SELECT COUNT(*) FROM events WHERE kind='doc.created' AND session_id=(SELECT session_id FROM events WHERE kind='ui.brief_requested')" "the brief isn't linked to the session"
need "SELECT COUNT(*) FROM events WHERE kind='ui.brief_continued' AND json_extract(payload,'$.silent')=0" "Continue sent no corrections"
need "SELECT COUNT(*) FROM events WHERE kind='ui.message_sent' AND json_extract(payload,'$.text') LIKE '%caught up%looks wrong%run nothing%'" "the correction didn't reach the session"
need "SELECT COUNT(*) FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result' AND id > (SELECT MIN(id) FROM events WHERE kind='ui.brief_continued')" "the session didn't resume after Continue"
need "SELECT COUNT(*) FROM events WHERE kind='sidecar.session_started' AND session_id=(SELECT session_id FROM events WHERE kind='ui.brief_requested')" "wrong session"
[ "$(sqlite3 "$db" "SELECT COUNT(DISTINCT session_id) FROM events WHERE kind='ui.session_requested'")" = "1" ] || { echo "FAILED: Continue started another session"; exit 1; }
echo "SELFTEST BRIEF PASSED ($db)"
