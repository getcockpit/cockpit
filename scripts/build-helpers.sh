#!/usr/bin/env bash
# Builds the two helper binaries Tauri bundles, for one target triple (default: this machine):
# src-tauri/binaries/mr-sidecar-<triple> and mr-dictate-<triple> (.exe on Windows).
# Used by CI on every OS. macOS gets the real Swift dictate helper; Linux and Windows a stub.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
bin="$root/src-tauri/binaries"
mkdir -p "$bin"
case "$triple" in
  aarch64-apple-darwin) bunt=bun-darwin-arm64 ;;
  x86_64-apple-darwin) bunt=bun-darwin-x64 ;;
  x86_64-unknown-linux-gnu) bunt=bun-linux-x64 ;;
  aarch64-unknown-linux-gnu) bunt=bun-linux-arm64 ;;
  x86_64-pc-windows-msvc) bunt=bun-windows-x64 ;;
  *) echo "unsupported target $triple" >&2; exit 1 ;;
esac
ext=""; [[ "$triple" == *windows* ]] && ext=".exe"
(cd "$root/sidecar" && bun install --silent)
bun build --compile --target="$bunt" "$root/sidecar/src/main.ts" --outfile "$bin/mr-sidecar-$triple$ext"
if [[ "$triple" == *apple-darwin ]]; then
  arch="${triple%%-*}"
  swiftc -O -target "$arch-apple-macos11" "$root/dictate/main.swift" -o "$bin/mr-dictate-$triple" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$root/dictate/Info.plist"
else
  bun build --compile --target="$bunt" "$root/dictate/stub.ts" --outfile "$bin/mr-dictate-$triple$ext"
fi
echo "built helpers for $triple"
