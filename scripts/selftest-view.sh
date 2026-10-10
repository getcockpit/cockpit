#!/usr/bin/env bash
# End-to-end check of render_view with real Claude (spends a little usage): asked for a status
# report without naming any tool, Claude should compose it from the catalog (decision 26, MR-61).
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=view MR_DATA_DIR="$data" "$root/src-tauri/target/debug/minority-report"
db="$data/events.sqlite"
echo "--- views"
sqlite3 "$db" "SELECT json_extract(payload,'$.title'), json_array_length(payload,'$.blocks') FROM events WHERE kind='view.rendered';"
sqlite3 "$db" "SELECT DISTINCT json_extract(b.value,'$.type') FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered';"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='view.rendered'" "Claude wrote the report as text instead of calling render_view"
need "SELECT COUNT(*) FROM events WHERE kind='view.rendered' AND json_array_length(payload,'$.blocks') >= 2" "the view has fewer than 2 blocks"
# MR-71: review findings, again without naming a block, should come back on the severity scale.
data2="$(mktemp -d)"
MR_VIEW_PROMPT="This is a UI test; nothing here is real and you don't need to look at any files. Summarise my pretend code review of a payments PR: one critical finding (a charge can run twice on retry, charge.ts:42), one important (the webhook isn't verified, webhook.ts:10) and one nitpick (a stray console.log). Then on a final line reply with exactly: SELFTEST DONE" \
  MR_SELFTEST=view MR_DATA_DIR="$data2" "$root/src-tauri/target/debug/minority-report"
db2="$data2/events.sqlite"
echo "--- review view blocks"
sqlite3 "$db2" "SELECT DISTINCT json_extract(b.value,'$.type') FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered';"
[ "$(sqlite3 "$db2" "SELECT COUNT(*) FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered' AND json_extract(b.value,'$.type')='findings'")" != "0" ] || { echo "FAILED: review findings weren't shown as a findings block"; exit 1; }
echo "SELFTEST VIEW PASSED ($db, $db2)"
