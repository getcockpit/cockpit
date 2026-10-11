#!/usr/bin/env bash
# End-to-end self-build: the app builds itself from this checkout, relaunches into the new build via
# the supervisor, and the new build reports healthy. No Claude usage. Takes a few minutes.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
MR_SELFTEST=selfbuild MR_DATA_DIR="$data" MR_APP_REPO="$root" "$root/src-tauri/target/debug/Cockpit" || true
id="$(ls "$data/builds" | grep -v fallbacks | head -1)"
[ -n "$id" ] || { echo "FAILED: no build stored"; sqlite3 "$data/events.sqlite" "SELECT payload FROM events WHERE kind='selfbuild.finished'"; exit 1; }
for _ in $(seq 1 120); do [ -f "$data/healthy-$id" ] && break; sleep 1; done
[ -f "$data/healthy-$id" ] || { echo "FAILED: new build $id never reported healthy"; cat "$data/builds/$id/run.log" 2>/dev/null | tail -20; exit 1; }
[ ! -f "$data/builds/fallbacks.log" ] || { echo "FAILED: supervisor fell back"; cat "$data/builds/fallbacks.log"; exit 1; }
cat "$data/builds/$id/build.json"; echo
echo "SELFTEST SELFBUILD PASSED"
