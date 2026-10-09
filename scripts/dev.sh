#!/usr/bin/env bash
# One command to run the app from source: builds the sidecar, then starts Tauri in dev mode.
# This is also the entry point the app will use to rebuild itself (MR-33).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/build-sidecar.sh"
(cd "$root/ui" && bun install --silent)
cd "$root/src-tauri" && cargo tauri dev "$@"
