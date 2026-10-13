# Installing Cockpit

Cockpit runs Claude Code sessions side by side and shows them as cards instead of terminal text.
It uses **your own** Claude Code login: it never sees or stores your tokens.

## You need

- One of:
  - **macOS 11+** (Apple Silicon or Intel): `Cockpit-<version>.dmg`
  - **Linux x64** with WebKitGTK 4.1 (Ubuntu 22.04+, Debian 12+, Fedora 38+): `.AppImage`, `.deb` or `.rpm`
  - **Windows 10/11 x64** (WebView2 is preinstalled on 11): `.msi` or `-setup.exe`
- Downloads: https://github.com/getcockpit/cockpit/releases/latest
- Claude Code installed and signed in. Check in Terminal: `claude --version`, then run `claude` once and log in.
  Not installed? `curl -fsSL https://claude.ai/install.sh | bash`

## Install on macOS (about 2 min)

1. Open `Cockpit-<version>.dmg` and drag **Cockpit** into **Applications**.
2. The app isn't notarized by Apple, so macOS blocks the first open. In Terminal, run:
   `xattr -dr com.apple.quarantine /Applications/Cockpit.app`
   (Or: open it once, then System Settings → Privacy & Security → **Open Anyway**.)
3. Open Cockpit from Applications and start a session in any project folder.

## Install on Linux (about 1 min)

- **AppImage:** `chmod +x Cockpit_*.AppImage && ./Cockpit_*.AppImage`
- **Debian/Ubuntu:** `sudo apt install ./Cockpit_*_amd64.deb`
- **Fedora/RHEL:** `sudo dnf install ./Cockpit-*.x86_64.rpm`

## Install on Windows (about 1 min)

1. Run `Cockpit_*_x64-setup.exe` (or the `.msi`).
2. SmartScreen may warn because the installer isn't code-signed yet: **More info → Run anyway**.
3. Make sure `claude` works in a new PowerShell window first.

## Good to know

- Your data stays on your machine: `~/Library/Application Support/dev.minorityreport.app` (macOS), `~/.local/share/dev.minorityreport.app` (Linux), `%APPDATA%\dev.minorityreport.app` (Windows).
- Linux and Windows are new: push-to-talk is macOS-only, and on Windows commands you run from Cockpit go through `cmd`.
- Auto-review (start `/review` on PRs waiting for you) is off; turn it on in Settings if you have a `/review` command.
- Push-to-talk (hold ⌥ Space) asks for microphone and speech permission the first time.
- Self-update, god mode and Builds are for working on Cockpit itself; they need its source repo and do nothing here.
- Optional: the Cockpit layer (auto-drawn cards and titles) needs an Anthropic API key, which you can add in the app. Everything else works without it.

## Building the installer (for the maintainer)

`./scripts/package.sh` → `dist/Cockpit-<version>.dmg` (universal, ad-hoc signed).
