// bun drive.ts <chrome-for-testing> <extension dir> <Cockpit binary> (run via scripts/e2e-browser.sh).
// The extension's worker against the real `Cockpit --browser-host` and a stub core socket, and the
// overlay on a hostile page driven by trusted CDP input only. Branded Chrome ignores
// --load-extension since 137, so this needs Chrome for Testing.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
const [cft, ext, bin] = process.argv.slice(2);
const here = import.meta.dir;
const D = mkdtempSync(`${tmpdir()}/mr-browser-e2e-`);
const sock = `${D}/s.sock`, reqLog = `${D}/requests.jsonl`;
const stub = Bun.spawn(["python3", "-I", `${here}/stub.py`, sock, reqLog]);
const http = Bun.spawn(["python3", "-I", "-m", "http.server", "18765", "--bind", "127.0.0.1", "--directory", here], { stdout: "ignore", stderr: "ignore" });
const wrapper = `${D}/host.sh`;
writeFileSync(wrapper, `#!/bin/sh\nexec '${bin}' --browser-host '${sock}' "$@"\n`); chmodSync(wrapper, 0o700);
mkdirSync(`${D}/NativeMessagingHosts`);
writeFileSync(`${D}/NativeMessagingHosts/dev.getcockpit.browser.json`, JSON.stringify({ name: "dev.getcockpit.browser", description: "Cockpit browser annotations", path: wrapper, type: "stdio", allowed_origins: ["chrome-extension://jikejkgnjdaenbejddeiniofbbnjmajh/"] }));
const chrome = Bun.spawn([cft, "--headless=new", `--user-data-dir=${D}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, "--remote-debugging-port=9334", "--window-size=1200,900", "about:blank"], { stdout: "ignore", stderr: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Poll for the extension's worker: a cold Chrome takes several seconds to start it.
let targets: any[] = [];
for (let i = 0; i < 60 && !targets.some((t) => t.type === "service_worker" && t.url.includes("jikejkgnjdaenbejddeiniofbbnjmajh")); i++) {
  await sleep(500);
  targets = await fetch("http://127.0.0.1:9334/json/list").then((r) => r.json(), () => []);
}
function cdp(url: string) {
  const ws = new WebSocket(url); let id = 0; const w = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
  const ready = new Promise((r) => (ws.onopen = r));
  return async (method: string, params = {}) => { await ready; return new Promise<any>((r) => { w.set(++id, r); ws.send(JSON.stringify({ id, method, params })); }); };
}
const evalIn = async (c: any, expr: string) => (await c("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, info = "") => results.push([name, ok, info]);

// 1. Worker → native host (the real Cockpit binary) → socket.
const sw = cdp(targets.find((t: any) => t.type === "service_worker" && t.url.includes("jikejkgnjdaenbejddeiniofbbnjmajh")).webSocketDebuggerUrl);
const t0 = Date.now();
const r = await evalIn(sw, `call({ type: "sessions", tab: "x:1", url: "http://localhost:5173/" }).then(JSON.stringify, e => "ERR " + e.message)`);
check("worker ↔ host ↔ socket round trip", String(r).includes("settings redesign"), `${Date.now() - t0} ms: ${r}`);
check("no cookies/debugger/tabs APIs", (await evalIn(sw, `[typeof chrome.cookies, typeof chrome.debugger].join()`)) === "undefined,undefined");

// 2. The overlay on a hostile page, driven by trusted input only.
const page = cdp(targets.find((t: any) => t.type === "page").webSocketDebuggerUrl);
await page("Page.enable");
await page("Page.navigate", { url: "http://127.0.0.1:18765/fixture.html" });
await sleep(1000);
const src = (f: string) => readFileSync(f, "utf8");
await evalIn(page, src(`${here}/shim.js`) + ";" + src(`${ext}/lib.js`) + ";" + src(`${ext}/annotator.js`) + "; 1");
await sleep(300);
check("closed shadow root hidden from the page", (await evalIn(page, "window.__sawHost === true && window.__shadow === null")) === true);
const key = async (p: any) => { await page("Input.dispatchKeyEvent", { type: "keyDown", ...p }); await page("Input.dispatchKeyEvent", { type: "keyUp", ...p }); };
const click = async (x: number, y: number) => {
  await page("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
await key({ key: "å", code: "KeyA", modifiers: 1, windowsVirtualKeyCode: 65 });
await sleep(200);
await click(160, 218);
await sleep(300);
await page("Input.insertText", { text: "should be disabled until something changes" });
await key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(800);
const pin = await evalIn(page, `JSON.stringify(window.__calls.find(c => c.msg?.type === "pin")?.msg.pin)`);
const p = pin ? JSON.parse(pin) : {};
check("⌥A + click + note makes a pin", p.note === "should be disabled until something changes", `selector=${p.selector}`);
check("selector finds the element again", p.selector === '[data-testid="save"]');
check("no password/hidden values leave the page", !!p.html && !/hunter2|tok123/.test(JSON.stringify(p)), p.html);
check("crop asked of the worker, with the redaction list", Array.isArray(await evalIn(page, `window.__calls.find(c => c.type === "capture")?.redact`)));
// A forged click on Review & send (shown once there's a pin) does nothing.
await evalIn(page, `[...window.__root.querySelectorAll("button")].find(b => b.textContent.startsWith("Review")).click(); 1`);
await sleep(200);
check("forged click ignored (isTrusted)", (await evalIn(page, `window.__calls.filter(c => c.msg?.type === "batch").length`)) === 0);
// Review & send, then Confirm & send, by trusted clicks.
const at = async (label: string) => evalIn(page, `(() => { const b = [...window.__root.querySelectorAll("button")].find(b => b.textContent.startsWith(${JSON.stringify(label)})); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
await key({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
const [rx, ry] = await at("Review");
await click(rx, ry);
await sleep(500);
const [cx, cy] = await at("Confirm & send");
await click(cx, cy);
await sleep(500);
const conf = await evalIn(page, `JSON.stringify(window.__calls.find(c => c.msg?.type === "confirm")?.msg)`);
check("Confirm & send names the session and order", !!conf && conf.includes('"session":"A"') && conf.includes('"order":["p0"]'), conf);
for (const [n, ok, info] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${info ? `  · ${info.slice(0, 160)}` : ""}`);
chrome.kill(); stub.kill(); http.kill();
process.exit(results.every((x) => x[1]) ? 0 : 1);
