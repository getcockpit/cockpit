// bun render.ts preview 1 3 7 …   → frames at those seconds (preview/)
// bun render.ts full [fps]          → every frame (frames/), then encode with ffmpeg
// FORMAT=45 bun render.ts …         → the 4:5 cut (1080x1350) into preview-45/ and frames-45/
import puppeteer from "puppeteer-core";
import { mkdirSync, rmSync } from "node:fs";
const [mode, ...rest] = process.argv.slice(2);
const TALL = process.env.FORMAT === "45", SUF = TALL ? "-45" : "";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files"],
  defaultViewport: TALL ? { width: 1080, height: 1350, deviceScaleFactor: 1 } : { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto("file://" + process.cwd() + "/film.html" + (TALL ? "?format=45" : ""), { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
const frame = async (t: number, path: string) => { await page.evaluate((t) => (window as any).seekFilm(t), t); await page.screenshot({ path, type: "jpeg", quality: 95 }); };
if (mode === "preview") {
  mkdirSync(`preview${SUF}`, { recursive: true });
  for (const s of rest) await frame(Number(s), `preview${SUF}/t${s}.jpg`);
} else if (mode === "range") {
  // re-render frames [from, to) seconds into frames/ (keeps the rest)
  const [from, to, fps = 60] = rest.map(Number);
  for (let i = Math.round(from * fps); i < Math.round(to * fps); i++) await frame(i / fps, `frames${SUF}/${String(i).padStart(5, "0")}.jpg`);
} else {
  const fps = Number(rest[0] ?? 30);
  rmSync(`frames${SUF}`, { recursive: true, force: true }); mkdirSync(`frames${SUF}`);
  const dur = await page.evaluate(() => (window as any).DURATION);
  const n = Math.round(dur * fps);
  for (let i = 0; i < n; i++) await frame(i / fps, `frames${SUF}/${String(i).padStart(5, "0")}.jpg`);
  console.log("frames", n);
}
await browser.close();
