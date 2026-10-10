#!/usr/bin/env bash
# Overhead benchmark (spends real usage): runs the same tasks through plain `claude -p` and through
# Minority report (MR_SELFTEST=bench), each in a fresh clone, and writes one stream per run to $out.
# Summarise with: python3 scripts/bench-overhead.py <out-dir>
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
reps="${REPS:-2}"
out="${1:-$(mktemp -d /tmp/mr-bench.XXXX)}"
mkdir -p "$out"
app="$root/src-tauri/target/debug/minority-report"
[ -x "$app" ] || { echo "build the app first (cargo build)"; exit 1; }

tasks=(
  "explain|Without changing anything: explain how the SQLite event log is replayed into UI state in this repo. Name the key files and functions. Keep it under 200 words."
  "edit|Rename the helper function clip in src-tauri/src/layer3.rs to clip_label and update every call site in that file. Don't build or run tests. Then show git diff --stat."
  "survey|Without changing anything: list every Rust module in src-tauri/src with a one-line purpose, and say which ones contain a #[cfg(test)] block."
)

run_plain() { # name prompt dir
  # Own session: when one run's app exits it must not take the other run (or this script) down.
  (cd "$3" && perl -MPOSIX=setsid -e 'setsid; exec @ARGV' claude -p "$2" --output-format stream-json --verbose --dangerously-skip-permissions >"$out/$1.plain.jsonl" 2>"$out/$1.plain.err" || true)
}
run_mr() { # name prompt dir
  local data; data="$(mktemp -d)"
  MR_SELFTEST=bench MR_BENCH_PROMPT="$2" MR_BENCH_CWD="$3" MR_DATA_DIR="$data" perl -MPOSIX=setsid -e 'setsid; exec @ARGV' "$app" >"$out/$1.mr.log" 2>&1 || true
  sqlite3 "$data/events.sqlite" "SELECT payload FROM events WHERE kind='sidecar.sdk' ORDER BY id" | python3 -c 'import sys,json; [print(json.dumps(json.loads(l)["message"])) for l in sys.stdin]' >"$out/$1.mr.jsonl"
}

for rep in $(seq 1 "$reps"); do
  for t in "${tasks[@]}"; do
    name="${t%%|*}"; prompt="${t#*|}"
    a="$out/repo-$name-$rep-plain"; b="$out/repo-$name-$rep-mr"
    git clone -q "$root" "$a"; git clone -q "$root" "$b"
    echo "[$(date +%T)] $name rep $rep"
    run_plain "$name-$rep" "$prompt" "$a" & run_mr "$name-$rep" "$prompt" "$b" & wait
  done
done
echo "$out"
