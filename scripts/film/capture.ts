// Captures the demo harness states at high resolution, plus the boxes (CSS px) of the elements the
// film's camera and cursor aim at. Output: shots/<name>.png and shots/boxes.json.
import puppeteer, { type Page } from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";

const W = 1600, H = 1000, DPR = 2;
const BASE = "http://localhost:1530/?demo=";
mkdirSync("shots", { recursive: true });
const boxes: Record<string, Record<string, { x: number; y: number; w: number; h: number }>> = {};

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb"],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
});
const page = await browser.newPage();

async function go(demo: string) {
  await page.goto(BASE + demo, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + demo, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500));
}
// The smallest visible element whose text starts with `text` (or matches a CSS selector with css:).
async function box(text: string) {
  return page.evaluate((text) => {
    let els: Element[];
    if (text.startsWith("css:")) els = [...document.querySelectorAll(text.slice(4))];
    else els = [...document.querySelectorAll("button, [aria-label], h1, h2, h3, div, span, section, article, li, p")]
      .filter((e) => { const t = text.replace(/\s+/g, ""); return [e.getAttribute("aria-label") ?? "", (e as HTMLElement).innerText ?? ""].some((s) => s.replace(/\s+/g, "").startsWith(t)); });
    els = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    els.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    const r = els[0]?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, text);
}
async function click(text: string) {
  const ok = await page.evaluate((text) => {
    const t = text.replace(/\s+/g, "");
    const els = [...document.querySelectorAll("button, [aria-label], [role=button], a")]
      .filter((e) => [e.getAttribute("aria-label") ?? "", (e as HTMLElement).innerText ?? ""].some((s) => s.replace(/\s+/g, "").startsWith(t)));
    const el = els.find((e) => (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
    el?.scrollIntoView({ block: "center" }); el?.click();
    return !!el;
  }, text);
  if (!ok) throw new Error("no element: " + text);
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function shot(name: string, targets: Record<string, string>) {
  boxes[name] = {};
  for (const [k, t] of Object.entries(targets)) {
    const b = await box(t);
    if (!b) console.warn(`  ${name}: no box for ${k} (${t})`);
    else boxes[name][k] = b;
  }
  await page.screenshot({ path: `shots/${name}.png` });
  console.log("shot", name);
}

await go("busy");
await click("Wall");
await shot("wall", { q1: "Sync for small accounts, or always", opt1: "1Always queue", q2: "Which formats ship in v1?", lamps: "4 need you", running: "4 running", tabs: "Personal" });
await click("1Always queue");
await shot("wall-answered", { first: "Which formats ship in v1?" });
await click("Open Retire the old invoices table");
await new Promise((r) => setTimeout(r, 800));
await shot("focus", { risk: "Drop the old invoices table", deny: "DDeny", allow: "AAllow", cmd: "psql", plan: "Plan", changes: "Changes", title: "Retire the old invoices table" });
await click("DDeny");
await shot("focus-denied", { reply: "Okay, production is untouched" });
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 1200));
await click("CSV export for invoices v2");
await shot("doc", { goal: "Goal · proposed", design: "Design · proposed", decide: "Decide first", walk: "spaceWalk through", q: "Open question · open" });
await go("timeline");
await click("Timeline");
await shot("timeline", { next: "Next 15 minutes", paused: "Paused · needs you", handle: "Handle Refactor auth", now: "Now ·" });
await go("review");
await click("Wall");
await click("Open /review");
await shot("review", { snippet: "Retry loop around the charge call", note1: "1Note it", tier: "Tier 2" });
await click("1Note it");
await shot("review-noted", { noted: "1Noted" });

writeFileSync("shots/boxes.json", JSON.stringify(boxes, null, 1));
await browser.close();
