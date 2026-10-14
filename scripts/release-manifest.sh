#!/usr/bin/env bash
# Writes latest.json for the in-app updater (MR-136) from a release's updater signatures.
#   scripts/release-manifest.sh <tag> <dir with the .sig files> [notes] > latest.json
# Expects, in <dir>: Cockpit-macos.app.tar.gz.sig, Cockpit-linux-x86_64.AppImage.sig and
# Cockpit-windows-x64-setup.exe.sig (each optional: a missing platform is left out).
# The universal macOS bundle serves both Apple Silicon and Intel.
set -euo pipefail
tag="$1"; dir="$2"; notes="${3:-}"
base="https://github.com/getcockpit/cockpit/releases/download/$tag"
entry() { # platform file
  local sig="$dir/$2.sig"
  [ -f "$sig" ] || return 0
  jq -n --arg p "$1" --arg url "$base/$2" --rawfile sig "$sig" '{($p): {signature: ($sig | rtrimstr("\n")), url: $url}}'
}
{
  entry darwin-aarch64 Cockpit-macos.app.tar.gz
  entry darwin-x86_64 Cockpit-macos.app.tar.gz
  entry linux-x86_64 Cockpit-linux-x86_64.AppImage
  entry windows-x86_64 Cockpit-windows-x64-setup.exe
} | jq -s --arg v "${tag#v}" --arg notes "$notes" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{version: $v, notes: $notes, pub_date: $date, platforms: add}'
