#!/usr/bin/env bash
# Makes a fresh checkout or worktree buildable: installs JS deps and compiles the sidecar binary.
# Idempotent; used by dev.sh and by the app when it builds itself in a new worktree (MR-33).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$root/sidecar" && bun install --silent)
(cd "$root/ui" && bun install --silent)
"$root/scripts/build-sidecar.sh"
