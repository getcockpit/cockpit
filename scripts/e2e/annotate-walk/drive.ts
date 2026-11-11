// bun drive.ts <out dir>: walks "Annotate a page" on the walk host (port 9337) with trusted input
// only, and saves a screenshot per step. The overlay's closed shadow root is read through DOM
// (pierce), never through page scripts.
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch("http://127.0.0.1:9337/json/list")).json();
const page = targets.find((t: any) => t.type === "page" && t.url.startsWith("http"));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const c = (method: string, params: any = {}) => new Promise<any>((r) => { w.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
let step = 0;
const shot = async (name: string) => { const r = await c("Page.captureScreenshot", { format: "png" }); writeFileSync(`${out}/${String(++step).padStart(2, "0")}-${name}.png`, Buffer.from(r.result.data, "base64")); };
const key = async (p: any) => { await c("Input.dispatchKeyEvent", { type: "keyDown", ...p }); await c("Input.dispatchKeyEvent", { type: "keyUp", ...p }); };
const move = (x: number, y: number) => c("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const click = async (x: number, y: number) => { await move(x, y); await c("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await c("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); };
const drag = async (a: number[], b: number[]) => { await move(a[0], a[1]); await c("Input.dispatchMouseEvent", { type: "mousePressed", x: a[0], y: a[1], button: "left", clickCount: 1 }); for (let i = 1; i <= 5; i++) await c("Input.dispatchMouseEvent", { type: "mouseMoved", x: a[0] + (b[0] - a[0]) * i / 5, y: a[1] + (b[1] - a[1]) * i / 5, button: "left", buttons: 1 }); await c("Input.dispatchMouseEvent", { type: "mouseReleased", x: b[0], y: b[1], button: "left", clickCount: 1 }); };
const type = (text: string) => c("Input.insertText", { text });
/** Every node, overlay shadow roots included, as [nodeId, node]. */
async function nodes() {
  const d = (await c("DOM.getDocument", { depth: -1, pierce: true })).result.root;
  const all: any[] = [];
  const walk = (n: any) => { all.push(n); for (const k of [...(n.children || []), ...(n.shadowRoots || [])]) walk(k); };
  walk(d); return all;
}
const textOf = (n: any): string => (n.nodeType === 3 ? n.nodeValue : n.nodeName === "STYLE" ? "" : [...(n.shadowRoots || []), ...(n.children || [])].map(textOf).join(" ").replace(/\s+/g, " "));
/** Centre of the first overlay element of `tag` whose text starts with `label`. */
async function at(label: string, tag = "BUTTON") {
  for (const n of await nodes()) if (n.nodeName === tag && textOf(n).trim().startsWith(label)) {
    const b = await c("DOM.getBoxModel", { backendNodeId: n.backendNodeId });
    const q = b.result?.model?.content; if (!q) continue;
    return [(q[0] + q[4]) / 2, (q[1] + q[5]) / 2];
  }
  throw new Error(`no ${tag} "${label}"`);
}
const overlayText = async () => (await nodes()).filter((n) => n.nodeName === "COCKPIT-ANNOTATIONS").map(textOf).join(" | ");

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };
await c("DOM.enable"); await c("Page.enable");
await sleep(800);
await shot("linked-page"); note("tray: " + await overlayText());
// Opened from Cockpit: already annotating, so hover and click the Save button straight away.
if (!(await overlayText()).includes("Annotating")) note("FAIL: not annotating on open");
const save = await c("Runtime.evaluate", { expression: "(() => { const r = document.querySelector('[data-testid=save]').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()", returnByValue: true });
const [sx, sy] = save.result.result.value;
await move(sx, sy); await sleep(150); await shot("annotate-hover");
await click(sx, sy); await sleep(300); await shot("note-bubble");
await type("Save stays enabled when nothing changed"); await key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await sleep(1200);
await shot("after-pin-1"); note("after pin 1: " + await overlayText());
// Second pin: a box drag over the danger zone, still in annotate mode?
await drag([300, 560], [900, 700]); await sleep(300); await shot("box-note");
await type("Danger zone too loud"); await key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await sleep(1200);
await shot("after-pin-2"); note("after pin 2: " + await overlayText());
// Review & send, then Esc closes the sheet, then again and ⌘↵ confirms.
await key({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(150);
const [rx, ry] = await at("Review"); await click(rx, ry); await sleep(600); await shot("review-sheet");
await key({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(200);
if ((await overlayText()).includes("Confirm & send")) note("FAIL: Esc didn't close the review");
const [qx, qy] = await at("Review"); await click(qx, qy); await sleep(600);
await key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 }); await sleep(1000);
await shot("after-send"); note("after send: " + await overlayText());
if ((await overlayText()).includes("Carry")) note("FAIL: Carry offered right after sending");
writeFileSync(`${out}/log.txt`, log.join("\n"));
ws.close(); process.exit(0);
