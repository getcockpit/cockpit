#!/usr/bin/env bash
# Runs the app from source (decision 27). The UI hot-reloads through Vite; the Rust core runs from
# one of two build slots (target/slot-a, target/slot-b). Update in the app builds the other slot in
# the background, then exits asking for it: this loop relaunches from the fresh slot within seconds,
# with running sessions resumed. Two slots, because overwriting the running sidecar binary would
# kill it. MR_WATCH=1 runs plain `cargo tauri dev` (rebuilds and relaunches on every Rust change).
set -euo pipefail
# GUI-launched processes get a minimal PATH; find cargo/rustc and bun the way a login shell would.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh"
if [ "${MR_WATCH:-}" = "1" ]; then cd "$root/src-tauri" && exec cargo tauri dev "$@"; fi

# Vite once for the whole run, so UI changes stay live across app restarts.
port=1420
if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  (cd "$root/ui" && exec bun run dev) &
  vite=$!
  trap 'kill "$vite" 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && break; sleep 0.2; done
fi

state="$root/src-tauri/target"
mkdir -p "$state"
slot="$(cat "$state/mr-slot" 2>/dev/null || echo a)"
resume=""
while true; do
  dir="$state/slot-$slot"
  # Incremental, and a no-op right after an in-app Update built this slot.
  (cd "$root/src-tauri" && CARGO_TARGET_DIR="$dir" cargo build)
  echo "$slot" >"$state/mr-slot"
  rm -f "$state/mr-update"
  MR_DEV_LOOP=1 MR_DEV_SLOT="$slot" MR_APP_REPO="$root" MR_AUTO_RESUME="$resume" "$dir/debug/minority-report" || true
  # The app writes the slot to switch to before it exits for an update; any other exit ends the run.
  [ -f "$state/mr-update" ] || break
  slot="$(cat "$state/mr-update")"
  resume=1
done
