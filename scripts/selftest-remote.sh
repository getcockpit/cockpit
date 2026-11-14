#!/usr/bin/env bash
# Cockpit Remote end to end (spends a little Claude usage): the real app with Remote on, and
# `Cockpit --remote-peer` playing the phone. It pairs by the QR text, catches up on the log, starts
# a session in a repo the Mac knows (by id, never a path), replies to it, and checks that a
# stranger's key and a made-up repo are refused. The log must show origin: "remote" on the rows
# the phone caused, and the new session's worktree.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
bin="$root/src-tauri/target/debug/Cockpit"
data="$(mktemp -d)"
db="$data/events.sqlite"
# MR_REMOTE_LOCAL=1 skips n0's relays and discovery (direct on this machine); unset it to go over the internet.
export MR_REMOTE_LOCAL="${MR_REMOTE_LOCAL-1}"
MR_SELFTEST=remote MR_DATA_DIR="$data" "$bin" &
app=$!
trap 'kill $app 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do [ -s "$data/remote-offer.txt" ] && break; sleep 0.5; done
[ -s "$data/remote-offer.txt" ] || { echo "FAILED: the app never showed a pairing code"; exit 1; }
phone="$data/phone.json"
peer() { MR_DATA_DIR= "$bin" --remote-peer "$@"; }
echo "--- pair"; peer "$phone" pair "$(cat "$data/remote-offer.txt")"
echo "--- known"; known=$(peer "$phone" known); echo "$known"
repo=$(echo "$known" | python3 -c 'import json,sys; print(json.load(sys.stdin)["known"]["repos"][0]["id"])')
echo "$known" | grep -q '/' && { echo "FAILED: a path leaked to the phone"; exit 1; }
echo "--- refused: unknown repo"; ! peer "$phone" start personal deadbeef "hi" || { echo "FAILED: unknown repo accepted"; exit 1; }
echo "--- refused: stranger"; ! peer "$data/stranger.json" known 2>/dev/null || { echo "FAILED: unpaired key got in"; exit 1; }
cp "$phone" "$data/stranger.json"; python3 - "$data/stranger.json" <<'PY'
import json,sys,secrets; p=sys.argv[1]; s=json.load(open(p)); s["secret"]=secrets.token_hex(32); json.dump(s,open(p,"w"))
PY
! peer "$data/stranger.json" known || { echo "FAILED: a stranger's key with the Mac's address got in"; exit 1; }
echo "--- start"; started=$(peer "$phone" start personal "$repo" "Reply with just the word: ready"); echo "$started"
session=$(echo "$started" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["session"])')
for _ in $(seq 1 120); do
  [ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE session_id='$session' AND kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result'")" != "0" ] && break; sleep 1
done
echo "--- send"; peer "$phone" send "$session" "Now reply with just: again"
for _ in $(seq 1 120); do
  [ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE session_id='$session' AND kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result'")" -ge 2 ] && break; sleep 1
done
echo "--- watch (catch-up after the cursor, then live)"; peer "$phone" watch 3 > "$data/watch.jsonl"; cut -c1-160 "$data/watch.jsonl" | head -5
grep -q '"t":"live"' "$data/watch.jsonl" || { echo "FAILED: no live marker after catch-up"; exit 1; }
need() { [ "$(sqlite3 "$db" "$1")" != "0" ] || { echo "FAILED: $2"; exit 1; }; }
need "SELECT COUNT(*) FROM events WHERE kind='ui.remote_paired'" "pairing not logged"
need "SELECT COUNT(*) FROM events WHERE session_id='$session' AND kind='ui.session_requested' AND json_extract(payload,'$.origin')='remote' AND json_extract(payload,'$.worktree') IS NOT NULL" "remote start without origin=remote or worktree"
need "SELECT COUNT(*) FROM events WHERE session_id='$session' AND kind='ui.message_sent' AND json_extract(payload,'$.origin')='remote'" "remote reply without origin=remote"
need "SELECT COUNT(*) FROM events WHERE session_id='$session' AND kind='sidecar.sdk' AND json_extract(payload,'$.message.type')='result'" "the session never finished a turn"
[ "$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind LIKE 'ui.%' AND json_extract(payload,'$.origin')='remote' AND session_id IS NOT '$session'")" = "0" ] || { echo "FAILED: origin=remote leaked onto other rows"; exit 1; }
echo "SELFTEST REMOTE PASSED ($db)"
