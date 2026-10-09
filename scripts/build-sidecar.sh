#!/usr/bin/env bash
# Compiles the sidecar into one self-contained binary where Tauri expects it:
# src-tauri/binaries/mr-sidecar-<target-triple>
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p "$root/src-tauri/binaries"
bun build --compile "$root/sidecar/src/main.ts" --outfile "$root/src-tauri/binaries/mr-sidecar-$triple"
echo "built src-tauri/binaries/mr-sidecar-$triple"
