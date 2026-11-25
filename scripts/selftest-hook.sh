#!/usr/bin/env bash
# End-to-end check with real Claude (spends a little usage): attach to terminal sessions (MR-219).
# A claude in a tmux pane (its own tmux server, its own --settings: ~/.claude is never touched)
# sends its permission prompts through `Cockpit --hook-relay` to the app:
#   1. answered in Cockpit: hook.answer, the tool runs, the pane's prompt goes away
#   2. answered in the pane: hook.resolved_elsewhere, the queue item clears
#   3. Cockpit quit: the pane prompts exactly as without the hook
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
exe="$root/src-tauri/target/debug/Cockpit"
data="$(mktemp -d)"
work="$(mktemp -d)/hookwork"
mkdir -p "$work"
db="$data/events.sqlite"
sock="$data/hook.sock"
tm="tmux -L mr-selftest-hook-$$"
settings="$data/claude-settings.json"
printf '{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"%s --hook-relay %s","timeout":600}]}]}}\n' "$exe" "$sock" > "$settings"

app=""
cleanup() { $tm kill-server 2>/dev/null || true; [ -n "$app" ] && kill "$app" 2>/dev/null || true; }
trap cleanup EXIT
fail() { echo "FAILED: $1"; echo "--- pane"; $tm capture-pane -p -t hook 2>/dev/null | grep -v '^\s*$' | tail -20 || true; exit 1; }
q() { sqlite3 "$db" "$1" 2>/dev/null || echo 0; }
# wait_for <seconds> <description> <shell condition>
wait_for() { local t=$(( $1 * 5 )); while [ $t -gt 0 ]; do eval "$3" && return 0; sleep 0.2; t=$((t-1)); done; fail "$2"; }
pane_has() { $tm capture-pane -p -t hook | grep -q "$1"; }
ask() { $tm send-keys -t hook "$1"; sleep 0.5; $tm send-keys -t hook Enter; }

MR_SELFTEST=hook MR_DATA_DIR="$data" "$exe" & app=$!
wait_for 30 "the app never opened hook.sock" '[ -S "$sock" ]'

# A clean environment: nothing from the shell this runs in (another Claude Code, Cockpit) leaks in.
$tm new-session -d -s hook -x 200 -y 50 -c "$work" "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_PID -u MR_SELFTEST -u MR_DATA_DIR claude --permission-mode default --settings '$settings'"
# A new folder asks to be trusted first.
for _ in $(seq 1 150); do
  if pane_has "trust this folder"; then $tm send-keys -t hook Down Enter; sleep 1; fi
  pane_has "manual mode" && break
  sleep 0.2
done
pane_has "manual mode" || fail "claude didn't start in the pane"
sleep 1

echo "--- 1. answered in Cockpit"
ask "Use the Bash tool to run exactly this command and nothing else: touch ANSWER_IN_COCKPIT.txt"
wait_for 90 "no hook.prompt for the first command" '[ "$(q "SELECT COUNT(*) FROM events WHERE kind='"'"'hook.prompt'"'"'")" -ge 1 ]'
wait_for 30 "the pane didn't show its own prompt while Cockpit was asked" 'pane_has "Do you want to proceed" || [ -f "$work/ANSWER_IN_COCKPIT.txt" ]'
wait_for 30 "no hook.answer" '[ "$(q "SELECT COUNT(*) FROM events WHERE kind='"'"'hook.answer'"'"'")" -ge 1 ]'
wait_for 30 "the command didn't run after Allow in Cockpit" '[ -f "$work/ANSWER_IN_COCKPIT.txt" ]'
q "SELECT json_extract(payload,'$.tool'), json_extract(payload,'$.input.command'), json_extract(payload,'$.cwd'), json_extract(payload,'$.pane') FROM events WHERE kind='hook.prompt' LIMIT 1;"
[ -n "$(q "SELECT json_extract(payload,'$.pane') FROM events WHERE kind='hook.prompt' LIMIT 1;")" ] || fail "the prompt didn't carry its tmux pane"
wait_for 60 "the first turn didn't finish" '! pane_has "esc to interrupt"'
sleep 1

echo "--- 2. answered in the pane"
ask "Use the Bash tool to run exactly this command and nothing else: touch ANSWER_IN_PANE.txt"
wait_for 90 "no hook.prompt for the second command" '[ "$(q "SELECT COUNT(*) FROM events WHERE kind='"'"'hook.prompt'"'"'")" -ge 2 ]'
wait_for 30 "the pane didn't prompt" 'pane_has "Do you want to proceed"'
$tm send-keys -t hook 1
wait_for 30 "the command didn't run after answering in the pane" '[ -f "$work/ANSWER_IN_PANE.txt" ]'
wait_for 10 "no hook.resolved_elsewhere" '[ "$(q "SELECT COUNT(*) FROM events WHERE kind='"'"'hook.resolved_elsewhere'"'"'")" -ge 1 ]'
[ "$(q "SELECT COUNT(*) FROM events WHERE kind='hook.answer'")" = "1" ] || fail "something answered the pane's prompt from Cockpit"
wait_for 60 "the second turn didn't finish" '! pane_has "esc to interrupt"'
sleep 1

echo "--- 3. Cockpit quit"
kill "$app"; wait "$app" 2>/dev/null || true; app=""
ask "Use the Bash tool to run exactly this command and nothing else: touch AFTER_QUIT.txt"
wait_for 90 "with Cockpit gone the pane didn't prompt" 'pane_has "Do you want to proceed"'
$tm send-keys -t hook 1
wait_for 30 "the command didn't run after answering in the pane" '[ -f "$work/AFTER_QUIT.txt" ]'

echo "--- events"
q "SELECT kind, json_extract(payload,'$.id') FROM events WHERE kind LIKE 'hook.%' ORDER BY id;"
echo "SELFTEST HOOK PASSED ($db)"
