#!/usr/bin/env bash
# Builds Cockpit Remote's web app (decisions 46, 47) into site/remote/:
#   v/<version>/   one immutable version: the phone UI on the web core + the wasm link, and
#                  files.json (every file's SHA-256); <version> = the first 12 hex of its root hash
#   current.json   {version, root}: what a first install takes (trust on first use)
#   index.html, sw.js, manifest, icons: the stable loader (ui/mobile/loader). Its service worker
#                  serves only a version it checked, and updates only to a root hash the Mac sends
# The root hash is sha256 over the sorted "<sha256>  <path>" lines, as sha256sum prints them.
# src-tauri/build.rs embeds current.json, so each Cockpit build vouches for its own web app.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
site="$root/site/remote"
"$root/crates/remote-web/build.sh" >/dev/null
tmp="$(mktemp -d)"
(cd "$root/ui" && VITE_MR_WEB=1 bunx vite build --config vite.mobile.config.ts --outDir "$tmp/app" --emptyOutDir >/dev/null)
if grep -rlaq "$HOME" "$tmp/app"; then echo "ABORT: a local path is in the web app" >&2; exit 1; fi
if ls "$tmp/app/assets" | grep -q '^backend-'; then echo "ABORT: the demo core (real-session fixtures) is in the web app" >&2; exit 1; fi
python3 -I - "$tmp/app" "$site" "$root/ui/mobile" <<'PY'
import hashlib, json, os, shutil, sys
app, site, mobile = sys.argv[1:4]
files = []
for d, _, fs in os.walk(app):
    for f in fs:
        p = os.path.relpath(os.path.join(d, f), app)
        files.append([p, hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest()])
files.sort()
root = hashlib.sha256("".join(f"{h}  {p}\n" for p, h in files).encode()).hexdigest()
version = root[:12]
os.makedirs(os.path.join(site, "v"), exist_ok=True)
prev = None
cur_path = os.path.join(site, "current.json")
if os.path.exists(cur_path):
    prev = json.load(open(cur_path)).get("version")
dest = os.path.join(site, "v", version)
if os.path.exists(dest):
    shutil.rmtree(dest)
shutil.copytree(app, dest)
json.dump({"version": version, "files": files}, open(os.path.join(dest, "files.json"), "w"), indent=0)
# The stable loader at /remote/. Its hash is vouched for too: browsers re-fetch sw.js on their
# own, so the app warns when the site's loader isn't the one this release shipped.
for f in ("index.html", "sw.js"):
    shutil.copy(os.path.join(mobile, "loader", f), os.path.join(site, f))
sw = hashlib.sha256(open(os.path.join(site, "sw.js"), "rb").read()).hexdigest()
json.dump({"version": version, "root": root, "sw": sw}, open(cur_path, "w"))
for f in ("manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"):
    shutil.copy(os.path.join(mobile, "public", f), os.path.join(site, f))
# Keep the current version and the one before (a phone may still be updating from it).
for v in os.listdir(os.path.join(site, "v")):
    if v not in (version, prev):
        shutil.rmtree(os.path.join(site, "v", v))
# The preview addresses moved to /remote/.
for old in ("app", "spike"):
    p = os.path.join(site, old)
    if os.path.isdir(p):
        shutil.rmtree(p)
os.makedirs(os.path.join(site, "spike"), exist_ok=True)
open(os.path.join(site, "spike", "index.html"), "w").write('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Cockpit Remote moved</title><body style="font:16px/1.5 -apple-system,sans-serif;padding:40px 20px"><h2>Cockpit Remote moved</h2><p>Remove this icon from your Home Screen, then open <a href="../">getcockpit.github.io/remote/</a> in Safari and add it to your Home Screen again (keep "Open as Web App" on). You\'ll pair once more.</p></body>')
print(f"web app version {version} ({len(files)} files), root {root[:16]}…")
PY
rm -rf "$tmp"
