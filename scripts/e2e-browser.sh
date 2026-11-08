#!/bin/sh
# The browser extension end to end, headless (no Claude, no running app): the real extension in
# Chrome for Testing, the real `Cockpit --browser-host`, a stub core socket, and the overlay driven
# by trusted input on a hostile page. Needs Chrome for Testing (`bunx @puppeteer/browsers install chrome@stable`).
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
CFT="${MR_CFT:-$(ls -d "$HOME"/.cache/puppeteer/chrome/*/chrome-*/*.app/Contents/MacOS/* "$HOME"/.cache/puppeteer/chrome/*/chrome-linux64/chrome 2>/dev/null | tail -1)}"
[ -x "$CFT" ] || { echo "Chrome for Testing not found; set MR_CFT"; exit 2; }
(cd src-tauri && cargo build -q)
perl -e 'alarm 120; exec @ARGV' bun scripts/e2e/browser-ext/drive.ts "$CFT" "$PWD/browser/extension" "$PWD/src-tauri/target/debug/Cockpit"
