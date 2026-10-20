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
MR_SELFTEST=view MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
echo "--- views"
sqlite3 "$db" "SELECT json_extract(payload,'$.title'), json_array_length(payload,'$.blocks') FROM events WHERE kind='view.rendered';"
sqlite3 "$db" "SELECT DISTINCT json_extract(b.value,'$.type') FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered';"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='view.rendered'" "Claude wrote the report as text instead of calling render_view"
need "SELECT COUNT(*) FROM events WHERE kind='view.rendered' AND json_array_length(payload,'$.blocks') >= 2" "the view has fewer than 2 blocks"
# MR-174: a shown view ends the turn; no model call follows it before the turn's result.
need "SELECT COUNT(*) = 0 FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='assistant' AND id > (SELECT MIN(id) FROM events WHERE kind='view.rendered') AND id < (SELECT MIN(id) FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result' AND id > (SELECT MIN(id) FROM events WHERE kind='view.rendered'))" "Claude was asked again after render_view (the turn didn't end there)"
# MR-71: review findings, again without naming a block, should come back on the severity scale.
data2="$(mktemp -d)"
MR_VIEW_PROMPT="This is a UI test; nothing here is real and you don't need to look at any files. Summarise my pretend code review of a payments PR: one critical finding (a charge can run twice on retry, charge.ts:42), one important (the webhook isn't verified, webhook.ts:10) and one nitpick (a stray console.log). Then on a final line reply with exactly: SELFTEST DONE" \
  MR_SELFTEST=view MR_DATA_DIR="$data2" "$root/src-tauri/target/debug/Cockpit"
db2="$data2/events.sqlite"
echo "--- review view blocks"
sqlite3 "$db2" "SELECT DISTINCT json_extract(b.value,'$.type') FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered';"
[ "$(sqlite3 "$db2" "SELECT COUNT(*) FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered' AND json_extract(b.value,'$.type')='findings'")" != "0" ] || { echo "FAILED: review findings weren't shown as a findings block"; exit 1; }
# MR-142: screenshots to judge, without naming a block, should come back as an image block.
data3="$(mktemp -d)"; shots="$(mktemp -d)"
python3 -I -c 'import sys,zlib,struct
def png(p, rgb):
    raw=b"".join(b"\0"+bytes(rgb)*64 for _ in range(40))
    c=lambda t,d: struct.pack(">I",len(d))+t+d+struct.pack(">I",zlib.crc32(t+d))
    open(p,"wb").write(b"\x89PNG\r\n\x1a\n"+c(b"IHDR",struct.pack(">IIBBBBB",64,40,8,2,0,0,0))+c(b"IDAT",zlib.compress(raw))+c(b"IEND",b""))
png(sys.argv[1]+"/login-before.png",(46,125,107)); png(sys.argv[1]+"/login-after.png",(179,38,30))' "$shots"
MR_VIEW_PROMPT="This is a UI test. A tester attached two screenshots for a bug report on the login page: $shots/login-before.png (before the change) and $shots/login-after.png (after it). Show them to me so I can look at them and tell you what is broken; don't fix anything. Then on a final line reply with exactly: SELFTEST DONE" \
  MR_SELFTEST=view MR_DATA_DIR="$data3" "$root/src-tauri/target/debug/Cockpit"
db3="$data3/events.sqlite"
echo "--- image view blocks"
sqlite3 "$db3" "SELECT DISTINCT json_extract(b.value,'$.type') FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered';"
[ "$(sqlite3 "$db3" "SELECT COUNT(*) FROM events e, json_each(e.payload,'$.blocks') b WHERE e.kind='view.rendered' AND json_extract(b.value,'$.type') IN ('images','image_compare') AND b.value LIKE '%login-after.png%'")" != "0" ] || { echo "FAILED: the screenshots weren't shown as an images or image_compare block"; exit 1; }
echo "SELFTEST VIEW PASSED ($db, $db2, $db3)"
