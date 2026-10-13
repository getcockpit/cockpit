// bun render-45.ts preview 1 3 7 …   → frames at those seconds (preview-45/)
// bun render-45.ts full   [fps]          → every frame (frames-45/), then encode with ffmpeg
import puppeteer from "puppeteer-core";
import { mkdirSync, rmSync } from "node:fs";
const [mode, ...rest] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files"],
  defaultViewport: { width: 1080, height: 1350, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto("file://" + process.cwd() + "/film-45.html", { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
const frame = async (t: number, path: string) => { await page.evaluate((t) => (window as any).seekFilm(t), t); await page.screenshot({ path, type: "jpeg", quality: 95 }); };
if (mode === "preview") {
  mkdirSync("preview-45", { recursive: true });
  for (const s of rest) await frame(Number(s), `preview-45/t${s}.jpg`);
} else if (mode === "range") {
  // re-render frames [from, to) seconds into frames-45/ (keeps the rest)
  const [from, to, fps = 60] = rest.map(Number);
  for (let i = Math.round(from * fps); i < Math.round(to * fps); i++) await frame(i / fps, `frames-45/${String(i).padStart(5, "0")}.jpg`);
} else {
  const fps = Number(rest[0] ?? 30);
  rmSync("frames-45", { recursive: true, force: true }); mkdirSync("frames-45");
  const dur = await page.evaluate(() => (window as any).DURATION);
  const n = Math.round(dur * fps);
  for (let i = 0; i < n; i++) await frame(i / fps, `frames-45/${String(i).padStart(5, "0")}.jpg`);
  console.log("frames", n);
}
await browser.close();
