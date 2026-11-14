#!/usr/bin/env bash
# Builds Cockpit Remote's web app (decision 46) into site/remote/app/: the wasm link
# (crates/remote-web/build.sh; needs Homebrew llvm + wasm-bindgen-cli) and the phone UI
# (ui/src/mobile on the web core). publish.sh ships site/ to getcockpit.github.io.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/crates/remote-web/build.sh" >/dev/null
out="$root/site/remote/app"
(cd "$root/ui" && VITE_MR_WEB=1 bunx vite build --config vite.mobile.config.ts --outDir "$out" --emptyOutDir >/dev/null)
if grep -rlaq "$HOME" "$out"; then echo "ABORT: a local path is in the web app" >&2; exit 1; fi
du -sh "$out" | sed 's/^/web app: /'
