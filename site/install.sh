#!/usr/bin/env bash
# Cockpit installer: curl -fsSL https://getcockpit.github.io/install.sh | bash
# macOS: installs the latest Cockpit.app into /Applications (or ~/Applications without write access).
# Linux: installs the latest AppImage to ~/.local/bin/cockpit.
# COCKPIT_DEST=<dir> installs the app elsewhere; COCKPIT_NO_OPEN=1 skips launching it.
set -euo pipefail
repo="getcockpit/cockpit"
api="https://api.github.com/repos/$repo/releases/latest"
say() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
latest="https://github.com/$repo/releases/latest/download"
# Fixed-name copies on every release (no API call, so no rate limit); the API is the fallback.
asset() {
  local stable="$1" pattern="$2"
  if curl -fsIL -o /dev/null "$latest/$stable"; then echo "$latest/$stable"; return; fi
  curl -fsSL "$api" | grep -o "\"browser_download_url\": *\"[^\"]*$pattern\"" | head -1 | sed 's/.*"\(https[^"]*\)"/\1/'
}

command -v claude >/dev/null 2>&1 || say "Claude Code isn't installed yet: curl -fsSL https://claude.ai/install.sh | bash (then run 'claude' once to sign in)"

case "$(uname -s)" in
  Darwin)
    url="$(asset Cockpit-macos.dmg '\.dmg')"; [ -n "$url" ] || fail "no macOS build in the latest release"
    tmp="$(mktemp -d)"; trap 'hdiutil detach -quiet "$tmp/mnt" 2>/dev/null || true; rm -rf "$tmp"' EXIT
    say "Downloading $(basename "$url")"
    curl -fL --progress-bar "$url" -o "$tmp/Cockpit.dmg"
    hdiutil attach -quiet -nobrowse -mountpoint "$tmp/mnt" "$tmp/Cockpit.dmg"
    dest="${COCKPIT_DEST:-/Applications}"; [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
    [ -d "$dest/Cockpit.app" ] && { say "Replacing the existing Cockpit"; rm -rf "$dest/Cockpit.app"; }
    cp -R "$tmp/mnt/Cockpit.app" "$dest/"
    # Downloaded with curl, so macOS doesn't quarantine it; clear the flag anyway in case it's set.
    xattr -dr com.apple.quarantine "$dest/Cockpit.app" 2>/dev/null || true
    say "Installed $dest/Cockpit.app"
    [ -n "${COCKPIT_NO_OPEN:-}" ] || open "$dest/Cockpit.app"
    ;;
  Linux)
    [ "$(uname -m)" = "x86_64" ] || fail "only x86_64 Linux builds for now"
    url="$(asset Cockpit-linux-x86_64.AppImage '\.AppImage')"; [ -n "$url" ] || fail "no Linux build in the latest release"
    mkdir -p "$HOME/.local/bin"
    say "Downloading $(basename "$url")"
    curl -fL --progress-bar "$url" -o "$HOME/.local/bin/cockpit"
    chmod +x "$HOME/.local/bin/cockpit"
    say "Installed ~/.local/bin/cockpit (needs WebKitGTK 4.1). Run: cockpit"
    ;;
  *) fail "On Windows, download the installer from https://github.com/$repo/releases/latest" ;;
esac
