// UI end-to-end suite (MR-150): drives the demo harness headless through PinchTab, one JTBD flow
// at a time, the way a user would: buttons by their accessible name, state by data-mr tags.
// No Claude, no usage. Run through scripts/e2e-ui.sh, which starts Vite; `bun scripts/e2e/ui.ts J4`
// runs only the flows whose name contains "J4".
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = process.env.MR_E2E_BASE ?? "http://localhost:1530";
const SHOTS = process.env.MR_E2E_SHOTS ?? "/tmp/mr-e2e";

function pt(...args: string[]): string {
  const r = spawnSync("pinchtab", args, { encoding: "utf8", env: process.env, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`pinchtab ${args.join(" ")}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Page-derived text is data only: it is matched against, never acted on beyond these checks.
type Node = { ref: string; role: string; name: string };
function snap(within?: string): Node[] {
  return [...pt("snap", ...(within ? [within] : [])).matchAll(/^(e\d+):(\S+) "(.*)"/gm)].map(([, ref, role, name]) => ({ ref, role, name }));
}

// Polls until `check` passes or the timeout hits; the last failure is the error.
async function until<T>(what: string, check: () => T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try { return check(); } catch (e) { if (Date.now() > end) throw new Error(`${what}: ${(e as Error).message}`); }
    await sleep(200);
  }
}

const ui = {
  async open(demo: string) {
    pt("nav", `${BASE}/?demo=${demo}`, "--block-images");
    await until("app rendered", () => { if (ui.count("[data-mr]") === 0) throw new Error("no data-mr element"); });
  },
  count: (css: string) => Number(pt("count", css).trim()),
  // `within` (CSS) scopes the lookup when the same label shows twice, e.g. two Send buttons.
  find(role: string, name: string | RegExp, within?: string): Node {
    const hit = snap(within).find((n) => n.role === role && (typeof name === "string" ? n.name.startsWith(name) : name.test(n.name)));
    if (!hit) throw new Error(`no ${role} "${name}"`);
    return hit;
  },
  async click(role: string, name: string | RegExp, within?: string) {
    const n = await until(`find ${role} "${name}"`, () => ui.find(role, name, within));
    pt("click", n.ref);
  },
  async fill(name: string, text: string) {
    const n = await until(`find textbox "${name}"`, () => ui.find("textbox", name));
    pt("fill", n.ref, text);
  },
  async press(key: string) { pt("press", key); },
  // Right-click at the element's centre: the Cockpit menu listens on the window (GodMode.tsx).
  async rightClick(role: string, name: string | RegExp) {
    const n = await until(`find ${role} "${name}"`, () => ui.find(role, name));
    pt("scrollintoview", n.ref);
    const b = Object.fromEntries([...pt("box", n.ref).matchAll(/(\w+):(-?[\d.]+)/g)].map(([, k, v]) => [k, Number(v)]));
    const at = ["--x", String(b.x + b.width / 2), "--y", String(b.y + b.height / 2)];
    pt("mouse", "move", ...at);
    pt("mouse", "down", ...at, "--button", "right");
    pt("mouse", "up", ...at, "--button", "right");
  },
  // For elements with no accessible role (diff lines).
  async clickCss(css: string) { await until(`find ${css}`, () => pt("click", `css:${css}`)); },
  seeText: (needle: string) => until(`expected text "${needle}"`, () => { if (!pt("text", "--full").includes(needle)) throw new Error("not on the page"); }),
  text: (css: string) => pt("text", `css:${css}`),
  // Expectations poll: the UI settles a beat after a click.
  see: (role: string, name: string | RegExp) => until(`expected ${role} "${name}"`, () => ui.find(role, name)),
  gone: (role: string, name: string | RegExp) => until(`expected no ${role} "${name}"`, () => {
    if (snap().some((n) => n.role === role && (typeof name === "string" ? n.name.startsWith(name) : name.test(n.name)))) throw new Error("still there");
  }),
  tags: (tag: string, n: number | ((n: number) => boolean)) => until(`expected ${typeof n === "number" ? n : "some"} [data-mr=${tag}]`, () => {
    const c = ui.count(`[data-mr="${tag}"]`);
    if (typeof n === "number" ? c !== n : !n(c)) throw new Error(`found ${c}`);
  }),
};
const some = (c: number) => c > 0;
// Shortcut labels follow the platform (ui/src/platform.ts): "⌘K" on a Mac, "Ctrl+K" in Linux CI.
const key = (k: string, rest: string) => new RegExp(`^(⌘|Ctrl\\+)${k} ${rest}$`);

type Flow = { name: string; run: () => Promise<void> };
const flows: Flow[] = [
  { name: "J1 first run shows the onboarding", run: async () => {
    await ui.open("fresh");
    await ui.tags("Onboarding", 1);
    for (const step of ["1 The wall", "2 Pictures", "3 Point", "4 Connect"]) await ui.see("button", step);
  } },
  { name: "J2 start a session from the empty wall", run: async () => {
    await ui.open("empty");
    await ui.click("button", key("K", "Start"));
    await ui.tags("KindTile", (c) => c >= 4);
    await ui.fill("What should Claude do?", "Add a health check endpoint");
    await ui.click("button", "↵ Start");
    await ui.tags("SessionName", 1);
    await until("session titled from the prompt", () => { if (!/health check/i.test(ui.text('[data-mr="SessionName"]'))) throw new Error("title missing the prompt"); });
  } },
  { name: "J3 the wall shows what needs me", run: async () => {
    await ui.open("busy");
    await ui.see("button", "4 need you");
    await ui.see("button", "4 running");
    await ui.see("button", "1 to review");
    await ui.tags("Tile", 4);
    await ui.tags("CommandCard", 1);
    await ui.tags("QuestionCard", 1);
    await ui.tags("DocQuestion", 2);
  } },
  { name: "J4 allow a risky command from the queue", run: async () => {
    await ui.open("busy");
    await ui.click("button", "A Allow");
    await ui.tags("CommandCard", 0);
    await ui.see("button", "3 need you");
  } },
  { name: "J4 answer a structured question", run: async () => {
    await ui.open("busy");
    await ui.click("button", "API gateway");
    await ui.click("button", "429 + Retry-After");
    await ui.click("button", "☐ /login");
    await ui.click("button", "Send", '[data-mr="QuestionCard"]');
    await ui.tags("QuestionCard", 0);
    await ui.see("button", "3 need you");
  } },
  { name: "J5 open a finished session and see what it did", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 1);
    await ui.tags("PlanPanel", 1);
    await ui.tags("ChangeMap", 1);
    await ui.tags("ChangeNode", some);
  } },
  { name: "J7 open the plan's doc map", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Open map ↵");
    await ui.tags("DocBlock", some);
    await ui.tags("DocNext", 1);
  } },
  { name: "J7 decide a doc question from the queue", run: async () => {
    await ui.open("busy");
    await ui.click("button", "1 Always queue");
    await ui.tags("DocQuestion", 1);
    await ui.see("button", "3 need you");
  } },
  { name: "J8 step into a waiting review", run: async () => {
    await ui.open("review");
    await ui.click("button", "↵ Continue review");
    await ui.tags("ReviewOverview", 1);
    await ui.tags("SnippetPager", 1);
    await ui.see("button", "space Next snippet");
  } },
  { name: "J8 step into a waiting address flow", run: async () => {
    await ui.open("address");
    await ui.click("button", "↵ Continue");
    await ui.tags("SessionName", 1);
  } },
  { name: "J9 mark a finished session done", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Done ✓");
    await ui.see("button", "0 to review");
  } },
  { name: "J9 the archive lists cleared sessions", run: async () => {
    await ui.open("archive");
    await ui.click("button", "Archive");
    await ui.tags("Archive", 1);
    await ui.tags("ArchivedSession", 2);
  } },
  { name: "Doc lifecycle: shipped docs close, a stalled one is dropped", run: async () => {
    await ui.open("doclife");
    await ui.tags("DocTile", 4);
    await ui.click("button", "Mark done");
    await ui.tags("DocTile", 3);
    await ui.click("button", /^Open$/); // the stalled-doc suggestion
    await ui.tags("DocStage", 1);
    await ui.click("button", "Drop doc");
    await ui.click("button", "Click again to drop this doc");
    await ui.tags("DocTile", 2);
  } },
  { name: "Doc lifecycle: a doc built without Build it can be marked shipped", run: async () => {
    await ui.open("doclife");
    await ui.click("button", /^Nightly backup check/);
    await ui.click("button", "Mark shipped");
    await ui.see("button", "Done, archive it");
  } },
  { name: "J10 right-click, mark as wrong, get a fix session", run: async () => {
    await ui.open("busy");
    await ui.rightClick("button", "4 need you");
    await ui.click("menuitem", "Mark as wrong & fix…");
    await ui.fill("What's wrong", "The lamp counts the doc questions twice");
    await ui.click("button", /Save mark and fix it$/);
    await ui.see("button", "Fix: The lamp counts the doc questions twice");
  } },
  { name: "J11 note a line in a session's diff", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.click("button", "Review", '[data-mr="ChangeMap"]');
    await ui.tags("ReviewChanges", 1);
    await ui.see("button", /Looks good · open a PR$/);
    await ui.clickCss('[data-mr="DiffView"] > div:nth-child(2) > div');
    await ui.fill("Note on line", "Guard against a missing user");
    await ui.press("Enter");
    await ui.click("button", /Send 1 note$/);
    await ui.tags("Toast", some);
  } },
  { name: "J12 address a PR from the picker", run: async () => {
    await ui.open("busy");
    await ui.click("button", key("K", "Start"));
    await ui.click("radio", "Address");
    await ui.see("button", "#479 Billing CSV export");
    await ui.click("button", "#479 Billing CSV export");
    // No clone known for acme/billing yet: it asks for the folder once (a native dialog from here).
    await ui.tags("AskRepo", 1);
  } },
  { name: "J13 note a plan block and regenerate", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Open map ↵");
    await ui.click("button", "Open Scope");
    await ui.fill("Note on this block", "Include refunds too");
    await ui.press("Enter");
    await ui.click("button", /Regenerate with 1 change$/);
    await ui.seeText("Changed in v3");
    await ui.see("button", /Build from this doc$/);
  } },
  { name: "J14 report a bug and get a fix session", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Report a bug");
    await ui.fill("What's wrong", "Archive opens empty");
    await ui.click("button", /Save mark and fix it$/);
    await ui.see("button", "Fix: Archive opens empty");
  } },
  { name: "J15 switch the theme in Settings", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Settings");
    await ui.tags("Look", 1);
    await ui.click("button", "Transit");
    await until("theme applied", () => { const t = pt("attr", "html", "data-theme").trim(); if (t !== "transit") throw new Error(`data-theme is "${t}"`); });
  } },
  { name: "J16 delete a workspace by typing its name", run: async () => {
    await ui.open("busy");
    await ui.rightClick("button", "Client A");
    await ui.click("menuitem", "Delete workspace…");
    await ui.tags("DeleteWorkspace", 1);
    await ui.fill("Workspace name to confirm", "Client A");
    await ui.click("button", "Delete workspace", '[data-mr="DeleteWorkspace"]');
    await ui.gone("button", "Client A");
    await ui.tags("WorkspaceTab", 1);
  } },
  { name: "J17 switch workspaces", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Client A");
    await ui.see("button", "Open Migrate the client's billing to Stripe Tax");
    await ui.see("button", "1 need you");
    await ui.click("button", "Personal");
    await ui.see("button", "4 need you");
  } },
  { name: "Errors light the error lamp", run: async () => {
    await ui.open("broken");
    await ui.see("button", "1 error");
  } },
];

const only = process.argv[2];
const picked = flows.filter((f) => !only || f.name.includes(only));
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
for (const f of picked) {
  const t = Date.now();
  try {
    await f.run();
    console.log(`PASS  ${f.name}  (${Date.now() - t} ms)`);
  } catch (e) {
    failed++;
    const shot = `${SHOTS}/${f.name.replace(/\W+/g, "-")}.png`;
    try { pt("screenshot", "-o", shot); } catch { /* the failure itself is what matters */ }
    console.log(`FAIL  ${f.name}\n      ${(e as Error).message}\n      screenshot: ${shot}`);
  }
}
console.log(`\n${picked.length - failed}/${picked.length} flows passed`);
process.exit(failed ? 1 : 0);
