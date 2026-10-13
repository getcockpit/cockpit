#!/usr/bin/env bash
# Builds a shareable installer: a universal (Apple Silicon + Intel) Cockpit.dmg, ad-hoc signed,
# at dist/Cockpit-<version>.dmg. Friends need macOS 11+ and their own signed-in `claude`.
# Without an Apple Developer ID the app isn't notarized: see docs/INSTALL.md for the first-open step.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$root/src-tauri/binaries"
mkdir -p "$bin" "$root/dist"

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
(cd "$root/sidecar" && bun install --silent)
(cd "$root/ui" && bun install --silent)

# Helpers for both architectures, then glued into the universal binaries Tauri looks for.
for arch in arm64:aarch64 x64:x86_64; do
  bunarch="${arch%%:*}"; rustarch="${arch##*:}"
  bun build --compile --target="bun-darwin-$bunarch" "$root/sidecar/src/main.ts" \
    --outfile "$bin/mr-sidecar-$rustarch-apple-darwin"
  swiftc -O -target "$rustarch-apple-macos11" "$root/dictate/main.swift" -o "$bin/mr-dictate-$rustarch-apple-darwin" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$root/dictate/Info.plist"
done
for b in mr-sidecar mr-dictate; do
  lipo -create "$bin/$b-aarch64-apple-darwin" "$bin/$b-x86_64-apple-darwin" -output "$bin/$b-universal-apple-darwin"
done

# Packaged UI: auto-review starts off (MR-93).
export VITE_MR_PACKAGED=1
# Ad-hoc signature ("-"): no Developer ID needed; Gatekeeper asks once on the friend's Mac.
# The Tauri CLI: cargo's if installed, else the one in ui/node_modules (CI).
tauri=(cargo tauri); cargo tauri --version >/dev/null 2>&1 || tauri=(node "$root/ui/node_modules/@tauri-apps/cli/tauri.js")
(cd "$root/src-tauri" && "${tauri[@]}" build --target universal-apple-darwin --bundles app \
  --config '{"bundle":{"macOS":{"signingIdentity":"-","minimumSystemVersion":"11.0","entitlements":"Entitlements.plist"}}}')

version="$(sed -n 's/^  "version": "\(.*\)",/\1/p' "$root/src-tauri/tauri.conf.json")"
# A plain drag-to-Applications DMG. (Tauri's own DMG step scripts Finder and fails intermittently.)
stage="$(mktemp -d)"
cp -R "$root/src-tauri/target/universal-apple-darwin/release/bundle/macos/Cockpit.app" "$stage/"
ln -s /Applications "$stage/Applications"
cp "$root/docs/INSTALL.md" "$stage/Read me first.md"
rm -f "$root/dist/Cockpit-$version.dmg"
hdiutil create -quiet -volname Cockpit -srcfolder "$stage" -format UDZO -ov "$root/dist/Cockpit-$version.dmg"
rm -rf "$stage"
echo "built dist/Cockpit-$version.dmg"
