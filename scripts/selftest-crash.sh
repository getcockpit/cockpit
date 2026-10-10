#!/usr/bin/env bash
# Crash guard self-test (MR-70): a "new" slot that crashes at start must be logged and rolled back
# to the last stable slot, which is told it's a recovery. Fake app binaries, no build, no Claude.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir -p "$t/slot-a/debug" "$t/slot-b/debug"
# Stable build: becomes ready, notes how it was started, exits normally.
cat >"$t/slot-a/debug/Cockpit" <<SH
#!/usr/bin/env bash
echo "a started recovered=\$MR_RECOVERED" >>"$t/runs"
echo ok >"\$MR_HEALTH_FILE"
SH
# New build: panics before it's ready.
cat >"$t/slot-b/debug/Cockpit" <<SH
#!/usr/bin/env bash
echo "b started" >>"$t/runs"
echo "thread 'main' panicked at src/lib.rs:42: boom" >&2
exit 101
SH
chmod +x "$t"/slot-*/debug/Cockpit
echo b >"$t/mr-slot"; echo a >"$t/mr-stable"
MR_DEV_NO_BUILD=1 "$root/scripts/dev-loop.sh" "$root" "$t" >/dev/null 2>&1 || true
grep -q "b started" "$t/runs" || { echo "FAIL: crashing slot never ran"; exit 1; }
grep -q "a started recovered=b" "$t/runs" || { echo "FAIL: no rollback to the stable slot"; cat "$t/runs"; exit 1; }
grep -q "crash at start · slot b" "$t/crashes.log" || { echo "FAIL: crash not logged"; exit 1; }
grep -q "panicked at src/lib.rs:42" "$t/crashes.log" || { echo "FAIL: crash output not logged"; exit 1; }
# If the stable slot crashes too, the loop stops instead of spinning.
cp "$t/slot-b/debug/Cockpit" "$t/slot-a/debug/Cockpit"; rm -f "$t/runs"
echo b >"$t/mr-slot"
if MR_DEV_NO_BUILD=1 "$root/scripts/dev-loop.sh" "$root" "$t" >/dev/null 2>&1; then echo "FAIL: should stop when nothing is stable"; exit 1; fi
[ "$(grep -c started "$t/runs")" -le 2 ] || { echo "FAIL: loop kept relaunching"; exit 1; }
echo "PASS: crash at start is logged and rolled back to the last stable build"
