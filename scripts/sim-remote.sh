#!/usr/bin/env bash
# Cockpit Remote on the iPhone simulator (doc "Cockpit Remote", phase 2), no Claude usage: builds
# the iOS app, starts a Mac Cockpit with Remote on (MR_SELFTEST=remote, which shows a pairing code
# and confirms it), launches the app paired by MR_REMOTE_PAIR, and checks that the phone caught up
# on the Mac's log. Leaves screenshots in $out. Needs Xcode with the iOS platform installed.
#   SEED=<data dir>   start the Mac from a copy of this data dir (e.g. a selftest-remote run) for real sessions
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${OUT:-$(mktemp -d)}"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
(cd "$root/mobile" && cargo tauri ios build --target aarch64-sim --debug --ci >"$out/ios-build.log" 2>&1) || { tail -20 "$out/ios-build.log"; echo "FAILED: iOS build"; exit 1; }
app=$(find "$root/mobile/src-tauri/gen/apple/build" -name '*.app' -path '*sim*' -maxdepth 4 | head -1)
[ -d "$app" ] || { echo "FAILED: no simulator .app"; exit 1; }
data="$(mktemp -d)"
# .backup, not cp: the log is in WAL mode, and a copied file alone misses the newest rows.
[ -n "${SEED:-}" ] && sqlite3 "$SEED/events.sqlite" ".backup '$data/events.sqlite'"
db="$data/events.sqlite"
MR_SELFTEST=remote MR_DATA_DIR="$data" "$root/src-tauri/target/debug/Cockpit" >"$out/mac.log" 2>&1 &
mac=$!
trap 'kill $mac 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do [ -s "$data/remote-offer.txt" ] && break; sleep 0.5; done
[ -s "$data/remote-offer.txt" ] || { echo "FAILED: the Mac never showed a pairing code"; exit 1; }
base=$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='ui.remote_paired'")
dev=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next(x["udid"] for k,v in sorted(d.items(), reverse=True) if "iOS" in k for x in v if x["name"].startswith("iPhone")))')
xcrun simctl boot "$dev" 2>/dev/null || true
xcrun simctl bootstatus "$dev" -b >/dev/null
xcrun simctl uninstall "$dev" dev.getcockpit.remote 2>/dev/null || true
xcrun simctl install "$dev" "$app"
SIMCTL_CHILD_MR_REMOTE_PAIR="$(cat "$data/remote-offer.txt")" xcrun simctl launch "$dev" dev.getcockpit.remote >/dev/null
paired() { sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind='ui.remote_paired'"; }
for _ in $(seq 1 60); do [ "$(paired)" -gt "$base" ] && break; sleep 1; done
[ "$(paired)" -gt "$base" ] || { cat "$out/mac.log" | tail -5; echo "FAILED: the simulator never paired"; exit 1; }
sleep 6
xcrun simctl io "$dev" screenshot "$out/wall.png" >/dev/null 2>&1
cache=$(find "$(xcrun simctl get_app_container "$dev" dev.getcockpit.remote data)" -name cache.sqlite | head -1)
mac_rows=$(sqlite3 "$db" "SELECT COUNT(*) FROM events WHERE kind <> 'sidecar.commands'")
phone_rows=$(sqlite3 "$cache" "SELECT COUNT(*) FROM events")
echo "mac rows: $mac_rows · phone rows: $phone_rows"
[ "$phone_rows" -gt 0 ] || { echo "FAILED: the phone cached nothing"; exit 1; }
# The phone only stops short by rows written after it caught up (the pairing's own row, the app's).
missing=$(sqlite3 "$db" "ATTACH '$cache' AS p; SELECT COUNT(*) FROM main.events m WHERE m.kind <> 'sidecar.commands' AND m.id <= (SELECT max(id) FROM p.events) AND m.id NOT IN (SELECT id FROM p.events);")
[ "$missing" = "0" ] || { echo "FAILED: $missing rows missing on the phone below its cursor"; exit 1; }
echo "SIM REMOTE PASSED (screenshots in $out)"
