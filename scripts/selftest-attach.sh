#!/usr/bin/env bash
# End-to-end check with real Claude (spends a little usage) of the message box's attachments
# (MR-141), driven in the real UI: a pasted screenshot, a dropped PDF and a folded long paste
# go out in one message, and Claude reads the image's colour and the PDF's word.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
# A debug build loads its UI from the dev server (devUrl): serve this checkout's UI for the run.
if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then echo "FAILED: port 1420 is taken; stop that dev server first"; exit 1; fi
(cd "$root/ui" && exec bunx vite --port 1420 --strictPort >/dev/null 2>&1) &
vite=$!
trap 'kill $vite 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -s -o /dev/null http://localhost:1420/ && break; sleep 0.2; done
data="$(mktemp -d)"
MR_SELFTEST=attach MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit" || true
db="$data/events.sqlite"
echo "--- UI steps"
sqlite3 "$db" "SELECT json_extract(payload,'$.step') || ' ' || payload FROM events WHERE kind='ui.selftest_attach' ORDER BY id;"
echo "--- message sent"
sqlite3 "$db" "SELECT json_array_length(payload,'$.attachments'), json_extract(payload,'$.attachments[0].mime'), json_extract(payload,'$.attachments[1].mime'), instr(json_extract(payload,'$.text'),'filler line 20') > 0, instr(json_extract(payload,'$.text'),'[Pasted text') FROM events WHERE kind='ui.message_sent';"
echo "--- last reply"
last=$(sqlite3 "$db" "SELECT json_extract(payload,'$.message.result') FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result' ORDER BY id DESC LIMIT 1;")
echo "$last"
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='ui.selftest_attach' AND json_extract(payload,'$.step')='image' AND json_extract(payload,'$.thumbnail')=1" "the pasted image got no thumbnail chip"
need "SELECT COUNT(*) FROM events WHERE kind='ui.selftest_attach' AND json_extract(payload,'$.step')='folded' AND json_extract(payload,'$.token')=1" "the long paste didn't fold into a token"
need "SELECT COUNT(*) FROM events WHERE kind='ui.selftest_attach' AND json_extract(payload,'$.step')='sent'" "the UI never sent the message"
need "SELECT COUNT(*) FROM events WHERE kind='ui.message_sent' AND json_array_length(payload,'$.attachments')=2 AND json_extract(payload,'$.attachments[0].mime')='image/png' AND json_extract(payload,'$.attachments[1].mime')='application/pdf' AND instr(json_extract(payload,'$.text'),'filler line 20')>0 AND instr(json_extract(payload,'$.text'),'[Pasted text')=0" "the message didn't carry the image, the PDF and the expanded paste"
need "SELECT COUNT(*) FROM events WHERE kind='ui.message_sent' AND json_extract(payload,'$.attachments[0].path') LIKE '$data/attachments/%'" "the pasted image wasn't saved under the data folder"
echo "$last" | grep -qi "red" || { echo "FAILED: Claude didn't see the image is red"; exit 1; }
echo "$last" | grep -q "BANANA" || { echo "FAILED: Claude didn't read BANANA from the PDF"; exit 1; }
echo "SELFTEST ATTACH PASSED ($db)"
