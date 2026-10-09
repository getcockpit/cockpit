#!/usr/bin/env bash
# Compiles the push-to-talk helper (Swift) to src-tauri/binaries/mr-dictate-<target-triple>, with its
# privacy usage strings embedded so macOS can ask for microphone and speech permission.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p "$root/src-tauri/binaries"
swiftc -O "$root/dictate/main.swift" -o "$root/src-tauri/binaries/mr-dictate-$triple" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$root/dictate/Info.plist"
echo "built src-tauri/binaries/mr-dictate-$triple"
