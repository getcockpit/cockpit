#!/usr/bin/env bash
# One command to run the app from source: builds the sidecar, then starts Tauri in dev mode.
# This is also the entry point the app will use to rebuild itself (MR-33).
set -euo pipefail
# GUI-launched processes get a minimal PATH; find cargo/rustc and bun the way a login shell would.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh"
# No Rust watcher: a merge to main used to rebuild and relaunch the app mid-session, killing every
# running session (felt like crashes). UI changes still hot-reload through Vite; Rust changes land
# when you choose Rebuild & relaunch (⌘⇧B), which resumes sessions. MR_WATCH=1 restores watching.
watch=(--no-watch); [ "${MR_WATCH:-}" = "1" ] && watch=()
cd "$root/src-tauri" && cargo tauri dev "${watch[@]}" "$@"
