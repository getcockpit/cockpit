#!/usr/bin/env bash
# The app's run loop (decision 27, MR-70): relaunch from the slot an in-app Update asks for, and if a
# launch crashes before it's ready, log it and roll back to the last slot that started fine.
# Usage: dev-loop.sh <repo root> <state dir>. MR_DEV_NO_BUILD=1 skips cargo (tests).
set -uo pipefail
root="$1"; state="$2"
slot="$(cat "$state/mr-slot" 2>/dev/null || echo a)"
resume=""
build=1      # 0 when relaunching the last stable slot after a crash: run it exactly as it was
recovered="" # set after a rollback, so the app can tell you what happened
while true; do
  dir="$state/slot-$slot"
  # Incremental, and a no-op right after an in-app Update built this slot.
  if [ "$build" = "1" ] && [ -z "${MR_DEV_NO_BUILD:-}" ]; then (cd "$root/src-tauri" && CARGO_TARGET_DIR="$dir" cargo build); fi
  echo "$slot" >"$state/mr-slot"
  rm -f "$state/mr-update" "$state/healthy-$slot"
  # Crash guard (MR-70): the app writes healthy-<slot> once its sidecar is ready. Its output is kept
  # (and still shown) so a crash at start can be logged with the last lines.
  code=0
  MR_DEV_LOOP=1 MR_DEV_SLOT="$slot" MR_APP_REPO="$root" MR_AUTO_RESUME="$resume" MR_HEALTH_FILE="$state/healthy-$slot" \
    MR_RECOVERED="$recovered" MR_CRASH_LOG="$state/crashes.log" \
    "$dir/debug/Cockpit" 2>&1 | tee "$state/slot-$slot.out" || code=$? # pipefail: the app's exit code
  if [ -f "$state/healthy-$slot" ]; then
    echo "$slot" >"$state/mr-stable" # it started fine: this slot is the one to fall back to
    recovered=""; build=1
    # The app writes the slot to switch to before it exits for an update; any other exit ends the run.
    [ -f "$state/mr-update" ] || break
    slot="$(cat "$state/mr-update")"
    resume=1
    continue
  fi
  # It exited before it was ready: a crash at start. Log it, then roll back to the last stable slot.
  stable="$(cat "$state/mr-stable" 2>/dev/null || true)"
  {
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') crash at start · slot $slot · $(git -C "$root" rev-parse --short HEAD 2>/dev/null) · exit $code"
    tail -n 40 "$state/slot-$slot.out" 2>/dev/null || true
  } >>"$state/crashes.log"
  echo "Cockpit crashed at start (slot $slot). Logged to src-tauri/target/crashes.log." >&2
  if [ -z "$stable" ] || [ "$stable" = "$slot" ] || [ ! -x "$state/slot-$stable/debug/Cockpit" ] || [ -n "$recovered" ]; then
    echo "No earlier stable build to roll back to; stopping. See src-tauri/target/crashes.log." >&2
    exit 1
  fi
  echo "Rolling back to the last stable build (slot $stable)." >&2
  recovered="$slot"; slot="$stable"; build=0; resume=1
done
