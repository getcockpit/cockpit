#!/usr/bin/env bash
# Compiles the sidecar into one self-contained binary where Tauri expects it:
# src-tauri/binaries/mr-sidecar-<target-triple>
set -euo pipefail
# GUI-launched processes get a minimal PATH; find cargo/rustc and bun the way a login shell would.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p "$root/src-tauri/binaries"
bun build --compile "$root/sidecar/src/main.ts" --outfile "$root/src-tauri/binaries/mr-sidecar-$triple"
echo "built src-tauri/binaries/mr-sidecar-$triple"
