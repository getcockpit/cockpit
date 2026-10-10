#!/usr/bin/env bash
# End-to-end check of one-click Update (MR-66), no Claude usage: runs scripts/dev.sh with a temporary
# data folder; the app builds the other slot, restarts into it through the dev loop, and the new
# launch reports back. Slow the first time (each slot's first build is a full one).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
data="$(mktemp -d)"
MR_SELFTEST=update MR_DATA_DIR="$data" "$root/scripts/dev.sh"
db="$data/events.sqlite"
echo "--- events"
sqlite3 "$db" "SELECT kind, payload FROM events WHERE kind IN ('app.started','update.started','update.step','update.finished','update.restarting','selftest.update_back') ORDER BY id;"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='update.finished' AND json_extract(payload,'$.ok')=1" "the update build didn't finish"
need "SELECT COUNT(*) FROM events WHERE kind='update.restarting'" "the app never restarted for the update"
need "SELECT COUNT(DISTINCT json_extract(payload,'$.slot')) = 2 FROM events WHERE kind='app.started'" "the relaunch didn't switch build slots"
need "SELECT COUNT(*) FROM events WHERE kind='selftest.update_back'" "the relaunched app never came back"
echo "SELFTEST UPDATE PASSED ($db)"
