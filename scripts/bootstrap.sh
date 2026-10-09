#!/usr/bin/env bash
# Makes a fresh checkout or worktree buildable: installs JS deps and compiles the sidecar binary.
# Idempotent; used by dev.sh and by the app when it builds itself in a new worktree (MR-33).
set -euo pipefail
# GUI-launched processes get a minimal PATH; find cargo/rustc and bun the way a login shell would.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$root/sidecar" && bun install --silent)
(cd "$root/ui" && bun install --silent)
"$root/scripts/build-sidecar.sh"
