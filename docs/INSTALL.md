# Installing Cockpit

Cockpit runs Claude Code sessions side by side and shows them as cards instead of terminal text.
It uses **your own** Claude Code login: it never sees or stores your tokens.

## You need

- A Mac on macOS 11 or later (Apple Silicon or Intel).
- Claude Code installed and signed in. Check in Terminal: `claude --version`, then run `claude` once and log in.
  Not installed? `curl -fsSL https://claude.ai/install.sh | bash`

## Install (about 2 min)

1. Open `Cockpit-<version>.dmg` and drag **Cockpit** into **Applications**.
2. The app isn't notarized by Apple, so macOS blocks the first open. In Terminal, run:
   `xattr -dr com.apple.quarantine /Applications/Cockpit.app`
   (Or: open it once, then System Settings → Privacy & Security → **Open Anyway**.)
3. Open Cockpit from Applications and start a session in any project folder.

## Good to know

- Your data stays on your Mac, in `~/Library/Application Support/dev.minorityreport.app`.
- Auto-review (start `/review` on PRs waiting for you) is off; turn it on in Settings if you have a `/review` command.
- Push-to-talk (hold ⌥ Space) asks for microphone and speech permission the first time.
- Self-update, god mode and Builds are for working on Cockpit itself; they need its source repo and do nothing here.
- Optional: the Cockpit layer (auto-drawn cards and titles) needs an Anthropic API key, which you can add in the app. Everything else works without it.

## Building the installer (for the maintainer)

`./scripts/package.sh` → `dist/Cockpit-<version>.dmg` (universal, ad-hoc signed).
