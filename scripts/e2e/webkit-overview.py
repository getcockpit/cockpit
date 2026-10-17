"""The Overview canvas (decision 40, MR-157) in real WebKit, the engine the Mac app runs on: pinch
(gesture events), ctrl/⌘-wheel, real keys, a real drag, focus-ring maths. No Claude, no usage.

  Needs: the demo harness (cd ui && bunx vite --port 1530), `safaridriver -p 4444` running, and Safari
  → Settings → Developer → "Allow remote automation" on (once).
  Run:   python3 -I scripts/e2e/webkit-overview.py

WebKit won't let script construct a real GestureEvent ("Illegal constructor"), so a plain event with
the gesture's fields stands in; it runs the same listener a trackpad pinch reaches.
"""
import json, sys, time, urllib.request
DRIVER = "http://localhost:4444"
def _new_session():
    req = urllib.request.Request(DRIVER + "/session", method="POST", data=json.dumps({"capabilities": {"alwaysMatch": {"browserName": "safari"}}}).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)["value"]["sessionId"]
SID = _new_session()
BASE = f"{DRIVER}/session/{SID}"
def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)["value"]
def js(src, *args): return call("POST", "/execute/sync", {"script": src, "args": list(args)})
def zoom(): return js("return document.querySelector('[data-mr=OverviewZoomLevel]').textContent")
results = []
def check(name, ok, detail): results.append((name, ok, detail)); print(("PASS" if ok else "FAIL"), name, "—", detail)

call("POST", "/window/rect", {"width": 1400, "height": 900})
call("POST", "/url", {"url": "http://localhost:1530/?demo=workspaces"})
for _ in range(40):
    if js("return !!document.querySelector('[data-mr=OverviewCanvas][data-fitted]')"): break
    time.sleep(0.25)
check("fits on open in WebKit", js("return !!document.querySelector('[data-mr=OverviewCanvas][data-fitted]')"), zoom())

# 1. WebKit trackpad pinch: GestureEvent start/change/end, cumulative scale.
z0 = float(zoom().rstrip('%'))
r = js("""
const c = document.querySelector('[data-mr=OverviewCanvas]'), b = c.getBoundingClientRect();
const mk = (type, scale) => {
  // WebKit won't let script build a real GestureEvent: a plain event carrying its fields runs the same listener.
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, { scale: { value: scale }, clientX: { value: b.left + b.width/2 }, clientY: { value: b.top + b.height/2 } });
  return e;
};
const out = { hasGestureEvent: typeof GestureEvent !== 'undefined' };
const s = mk('gesturestart', 1); c.dispatchEvent(s); out.startPrevented = s.defaultPrevented;
for (const k of [1.1, 1.25, 1.4]) { const e = mk('gesturechange', k); c.dispatchEvent(e); out.changePrevented = e.defaultPrevented; }
const e = mk('gestureend', 1.4); c.dispatchEvent(e);
out.scaleRead = mk('gesturechange', 1.4).scale;
return out;
""")
time.sleep(0.4)
z1 = float(zoom().rstrip('%'))
check("WebKit defines GestureEvent (what a real trackpad pinch delivers)", r["hasGestureEvent"], json.dumps(r))
check("pinch 1.0→1.4 zooms ×1.4 around the fingers", abs(z1 / z0 - 1.4) < 0.03, f"{z0}% → {z1}%")
check("pinch is kept from zooming the whole page (preventDefault)", r["startPrevented"] and r["changePrevented"], "gesturestart/change defaultPrevented")

# 2. ctrl+wheel in WebKit (Chromium-style pinch, and ⌘-scroll): modifiers honoured by WebKit's WheelEvent.
z1 = float(zoom().rstrip('%'))
js("const c=document.querySelector('[data-mr=OverviewCanvas]'), b=c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel',{deltaY:-10, ctrlKey:true, bubbles:true, cancelable:true, clientX:b.left+200, clientY:b.top+200}));")
time.sleep(0.2); z2 = float(zoom().rstrip('%'))
check("ctrl+wheel zooms smoothly (1:1, exp(0.1))", abs(z2 / z1 - 2.718281828**0.1) < 0.02, f"{z1}% → {z2}%")
js("const c=document.querySelector('[data-mr=OverviewCanvas]'); c.dispatchEvent(new WheelEvent('wheel',{deltaY:-100, metaKey:true, bubbles:true, cancelable:true}));")
time.sleep(0.2); z3 = float(zoom().rstrip('%'))
check("one ⌘-scroll notch is one 1.16× step", abs(z3 / z2 - 2.718281828**0.15) < 0.02, f"{z2}% → {z3}%")
# gesture live: a ctrl+wheel arriving with it is dropped
js("""const c=document.querySelector('[data-mr=OverviewCanvas]'); const e = new Event('gesturestart',{bubbles:true,cancelable:true}); Object.defineProperty(e,'scale',{value:1}); c.dispatchEvent(e);
c.dispatchEvent(new WheelEvent('wheel',{deltaY:-10, ctrlKey:true, bubbles:true, cancelable:true}));""")
time.sleep(0.2); z4 = float(zoom().rstrip('%'))
js("""const c=document.querySelector('[data-mr=OverviewCanvas]'); const e = new Event('gestureend',{bubbles:true,cancelable:true}); Object.defineProperty(e,'scale',{value:1}); c.dispatchEvent(e);""")
check("no double zoom: ctrl+wheel during a live gesture is ignored", z4 == z3, f"{z3}% → {z4}%")

# 3. Real keyboard through WebDriver actions: + and − and Esc.
js("document.activeElement && document.activeElement.blur && document.activeElement.blur()")
def keys(*ks):
    acts = []
    for k in ks: acts += [{"type": "keyDown", "value": k}, {"type": "keyUp", "value": k}]
    call("POST", "/actions", {"actions": [{"type": "key", "id": "kb", "actions": acts}]})
za = float(zoom().rstrip('%')); keys("-"); time.sleep(0.4); zb = float(zoom().rstrip('%'))
check("real − key zooms out ÷1.25 in WebKit", abs(za / zb - 1.25) < 0.03, f"{za}% → {zb}%")
call("POST", "/actions", {"actions": [{"type": "key", "id": "kb2", "actions": [{"type": "keyDown", "value": ""}, {"type": "keyDown", "value": "="}, {"type": "keyUp", "value": "="}, {"type": "keyUp", "value": ""}]}]})
time.sleep(0.4); zc = float(zoom().rstrip('%'))
check("real ⇧= (+) zooms in ×1.25", abs(zc / zb - 1.25) < 0.03, f"{zb}% → {zc}%")

# 4. Real pointer drag of a workspace header: moves it, opens nothing; a click (WebKit doesn't focus buttons) opens.
box = js("const r=document.querySelector('[data-mr=OverviewHeader][data-mr-source=ws_client]').getBoundingClientRect(); return [r.right-40, r.top+r.height/2];")
before = js("return document.querySelector('[data-mr=OverviewArea][data-mr-source=ws_client]').style.left")
x, y = int(box[0]), int(box[1])
call("POST", "/actions", {"actions": [{"type": "pointer", "id": "m", "parameters": {"pointerType": "mouse"}, "actions": [
    {"type": "pointerMove", "x": x, "y": y, "origin": "viewport"}, {"type": "pointerDown", "button": 0},
    {"type": "pointerMove", "x": x + 20, "y": y, "origin": "viewport", "duration": 50},
    {"type": "pointerMove", "x": x + 260, "y": y + 30, "origin": "viewport", "duration": 200}, {"type": "pointerUp", "button": 0}]}]})
time.sleep(0.5)
after = js("return document.querySelector('[data-mr=OverviewArea][data-mr-source=ws_client]')?.style.left")
still = js("return !!document.querySelector('[data-mr=OverviewCanvas]')")
check("real drag moves a workspace and opens nothing", still and after != before, f"left {before} → {after}")
check("WebKit doesn't focus a clicked button (Space-drag stays a pan)", js("return document.activeElement.tagName") != "BUTTON", js("return document.activeElement.tagName"))

# 5. Focus ring at far zoom: outline width divided by zoom stays 2 px on screen.
for _ in range(6): keys("-")
time.sleep(0.4)
# The ring rule's maths, measured on a probe inside the camera layer (focus state doesn't matter).
w = js("""const cam=document.querySelector('.mr-ov-cam'), p=document.createElement('button'); p.style.cssText='outline:calc(2px / var(--mr-ov-z, 1)) solid red'; cam.appendChild(p);
const out=[parseFloat(getComputedStyle(p).outlineWidth), parseFloat(getComputedStyle(cam).getPropertyValue('--mr-ov-z'))]; p.remove(); return out;""")
check("focus ring stays 2 px on screen far out (calc(2px / --mr-ov-z) in WebKit)", abs(w[0] * w[1] - 2) < 0.3, f"{w[0]:.2f}px × zoom {w[1]:.3f} = {w[0]*w[1]:.2f}px")

print("\nSUMMARY", sum(1 for r in results if r[1]), "of", len(results), "passed")
urllib.request.urlopen(urllib.request.Request(BASE, method="DELETE"), timeout=30)
sys.exit(0 if all(r[1] for r in results) else 1)
