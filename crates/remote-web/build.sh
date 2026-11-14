#!/usr/bin/env bash
# Builds Cockpit Remote's browser link (decision 46) into pkg/: remote-link compiled to wasm32 plus
# wasm-bindgen's JS glue. `ring` needs a clang that targets wasm32 (Apple's doesn't):
#   brew install llvm && cargo install wasm-bindgen-cli --version <the wasm-bindgen in Cargo.lock>
# `./build.sh check` runs clippy for the wasm target instead.
set -euo pipefail
cd "$(dirname "$0")"
llvm="$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)/bin"
[ -x "$llvm/clang" ] || { echo "needs Homebrew llvm (brew install llvm)"; exit 1; }
export CC_wasm32_unknown_unknown="$llvm/clang" AR_wasm32_unknown_unknown="$llvm/llvm-ar"
if [ "${1:-}" = "check" ]; then exec cargo clippy --target wasm32-unknown-unknown; fi
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/remote_web.wasm
ls -la pkg/remote_web_bg.wasm
