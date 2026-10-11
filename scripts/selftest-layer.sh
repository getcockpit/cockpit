#!/usr/bin/env bash
# The Cockpit layer (decision 34): with it on, the session runs as plain Claude Code (no view tools,
# no Cockpit prompt), and after the turn the layer draws the cards on its own key. A local stub
# stands in for the API through MR_COCKPIT_BASE_URL (the hosted slot), so no real key is spent.
# Checks: cards recorded, the call metered, and the key never in the event log.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/bun/latest/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/bootstrap.sh" >/dev/null
(cd "$root/ui" && bun run build >/dev/null)
(cd "$root/src-tauri" && cargo build -q)
data="$(mktemp -d)"
key="sk-ant-selftest-$(uuidgen | tr -d -)"
port=$((20000 + RANDOM % 20000))
cat > "$data/stub.py" <<'PY'
import http.server, json, os, sys
key, out = os.environ["STUB_KEY"], os.environ["STUB_OUT"]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        if self.headers.get("x-api-key") != key:
            self.send_response(401); self.end_headers(); return
        open(out, "wb").write(body)
        view = {"title": "Settings refactor", "blocks": [{"type": "progress", "n": 3, "total": 5, "label": "Steps"}, {"type": "next", "text": "Fix the migration test", "replies": ["Fix it"]}]}
        r = {"content": [{"type": "tool_use", "id": "t1", "name": "show", "input": {"title": "Settings refactor status", "view": view}}], "usage": {"input_tokens": 1500, "output_tokens": 300}}
        b = json.dumps(r).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
STUB_KEY="$key" STUB_OUT="$data/request.json" python3 -I "$data/stub.py" "$port" & stub=$!
trap 'kill $stub 2>/dev/null' EXIT
MR_SELFTEST=layer MR_DATA_DIR="$data" MR_COCKPIT_API_KEY="$key" MR_COCKPIT_BASE_URL="http://127.0.0.1:$port" perl -e 'alarm 180; exec @ARGV' "$root/src-tauri/target/debug/Cockpit"
db="$data/events.sqlite"
q() { sqlite3 "$db" "$1"; }
fail() { echo "FAILED: $1"; exit 1; }
[ "$(q "SELECT json_extract(payload,'$.cockpit_layer') FROM events WHERE kind='ui.session_requested' LIMIT 1;")" = "1" ] || fail "session not started on the layer"
tools="$(q "SELECT payload FROM events WHERE kind='sidecar.sdk' AND json_extract(payload,'$.message.subtype')='init' LIMIT 1;")"
[ -n "$tools" ] || fail "no init message"
echo "$tools" | grep -qE 'render_view|plan_set|title_set' && fail "the session still had view tools"
[ "$(q "SELECT count(*) FROM events WHERE kind='view.rendered' AND json_extract(payload,'$.by')='cockpit';")" = "1" ] || fail "no card from the layer"
[ "$(q "SELECT json_extract(payload,'$.title') FROM events WHERE kind='session.titled' LIMIT 1;")" = "Settings refactor status" ] || fail "no title from the layer"
[ "$(q "SELECT json_extract(payload,'$.ok') || ' ' || json_extract(payload,'$.purpose') FROM events WHERE kind='cockpit.usage' LIMIT 1;")" = "1 render" ] || fail "the call wasn't metered"
grep -q "211" "$data/request.json" || fail "the layer didn't read the turn"
grep -aq "$key" "$db" "$db-wal" 2>/dev/null && fail "the key is in the event log"
[ -s "$data/request.json" ] && ! grep -q "$key" "$data/request.json" || fail "the key leaked into the request body"
echo "metered: $(q "SELECT json_extract(payload,'$.input_tokens') || ' in, ' || json_extract(payload,'$.output_tokens') || ' out, \$' || json_extract(payload,'$.cost_usd') FROM events WHERE kind='cockpit.usage';")"
echo "SELFTEST LAYER PASSED"
