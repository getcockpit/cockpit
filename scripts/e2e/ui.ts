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
const MOD = process.platform === "darwin" ? "Meta+" : "Control+";
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
  async open(demo: string, opts: { overview?: boolean } = {}) {
    // motion=off: a headless tab draws no frames, so entry animations would leave tiles at opacity 0,
    // which PinchTab's click treats as hidden. landing=wall: flows start on the Wall, not the
    // Overview a launch with several workspaces lands on (decision 40), unless they test that.
    pt("nav", `${BASE}/?demo=${demo}&motion=off${opts.overview ? "" : "&landing=wall"}`, "--block-images");
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
  // Clicks until `tag` shows: a click that lands mid-render (a stale ref) is simply retried.
  async clickUntil(role: string, name: string | RegExp, within: string | undefined, tag: string) {
    await until(`${tag} after clicking ${role} "${name}"`, () => {
      if (ui.count(`[data-mr="${tag}"]`) > 0) return;
      pt("click", ui.find(role, name, within).ref);
      throw new Error("not open yet");
    }, 8000);
  },
  async fill(name: string, text: string) {
    const n = await until(`find textbox "${name}"`, () => ui.find("textbox", name));
    pt("fill", n.ref, text);
  },
  async press(key: string) { pt("press", key); },
  // A shortcut, with "Mod" for the platform's command key (⌘ on a Mac, Ctrl in Linux CI).
  // PinchTab drops modifiers on punctuation and types unknown names as text, so ⌘, ⌘. and ⌥Space
  // are unit-tested in ui/src/components/keys.test.ts instead; Space is " ".
  async key(...combos: string[]) { for (const c of combos) { pt("press", c.replace(/\bMod\+/g, MOD)); await sleep(80); } },
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
  // Any CSS: rows marked aria-current, open dialogs, a pressed tab.
  css: (css: string, n: number | ((n: number) => boolean)) => until(`expected ${typeof n === "number" ? n : "some"} ${css}`, () => {
    const c = ui.count(css);
    if (typeof n === "number" ? c !== n : !n(c)) throw new Error(`found ${c}`);
  }),
  // Which row of a component is selected (aria-current), by its data-mr-source.
  selectedId: (tag: string) => pt("attr", `css:[aria-current="true"][data-mr="${tag}"]`, "data-mr-source").trim(),
  // The selected row (aria-current) is this component.
  selected: (tag: string) => until(`expected the selection on ${tag}`, () => { if (ui.count(`[aria-current="true"][data-mr="${tag}"]`) !== 1) throw new Error("not selected"); }),
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
  { name: "J8 publish a review and approve it on my behalf", run: async () => {
    await ui.open("review");
    await ui.click("button", "↵ Continue review");
    for (const n of [2, 3]) { await ui.key(" "); await ui.seeText(`Snippet ${n} of 3`); }
    await ui.key(" "); // finish the walkthrough: the review is ready to publish
    await ui.see("button", "⌘↵ Publish as one review");
    await ui.click("checkbox", "Approve on my behalf");
    await ui.see("button", "⌘↵ Publish and approve");
    await ui.click("button", "⌘↵ Publish and approve");
    await ui.seeText("✓ Published · approved");
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
    await ui.tags("DocStage", 1);
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
    await ui.clickUntil("button", "Review", '[data-mr="ChangeMap"]', "ReviewChanges");
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
  { name: "J19 see every workspace on the Overview and pick where to go", run: async () => {
    await ui.open("workspaces", { overview: true });
    await ui.tags("OverviewArea", 3); // launch lands on the canvas
    await ui.tags("OverviewBlock", 11); // a clean finish (Bump the lockfile) is gone
    await ui.gone("button", "Open Bump the lockfile");
    await until("needs-you count beside Cockpit dev", () => { if (!ui.text('[data-mr="OverviewArea"][data-mr-source="ws_cockpit"]').includes("1 needs you")) throw new Error("no count label"); });
    await ui.css('[data-mr="OverviewArea"] [data-mr="OverviewBlock"] button', 0); // read-only: nothing to answer on the map
    await ui.rightClick("button", "Open Voice: push to talk"); // Esc closes the right-click menu…
    await ui.css("[data-mr-menu]", 1);
    await ui.press("Escape");
    await ui.css("[data-mr-menu]", 0);
    await ui.tags("OverviewCanvas", 1); // …and only the menu: still on the Overview
    // Fit lays three workspaces out as a grid, so launch lands readable, not at half size in one long row.
    // Fitted (not the unfitted start), and still readable.
    await ui.css('[data-mr="OverviewCanvas"][data-fitted]', 1);
    await until("fit is readable", () => { const z = parseInt(ui.text('[data-mr="OverviewZoomLevel"]'), 10); if (!(z >= 60)) throw new Error(`fit at ${z}%`); });
    for (let i = 0; i < 4; i++) await ui.press("-"); // − zooms out from the keyboard…
    await ui.tags("OverviewLamps", 3); // …far out, each workspace is its name, what needs you and a lamp per item
    await until("double-click Client X", () => pt("dblclick", ui.find("button", "Zoom to workspace Client X").ref)); // far out, even a double-click only zooms in…
    await ui.tags("OverviewCanvas", 1);
    await ui.tags("OverviewLamps", 0);
    await ui.see("button", "Open Quarterly usage report"); // …close enough to read, still on the map
    for (let i = 0; i < 4; i++) await ui.press("-");
    await ui.tags("OverviewLamps", 3);
    await until("needs-you badge stays far out", () => { if (!ui.text('[data-mr="OverviewArea"][data-mr-source="ws_cockpit"]').includes("⚠ 1")) throw new Error("no badge"); });
    await ui.key("Mod+0");
    await ui.tags("OverviewLamps", 0);
    for (let i = 0; i < 4; i++) await ui.press("-");
    await ui.click("button", /go to 100%/); // 100% lands on a workspace, even from far out over a gap
    await until("100%", () => { if (ui.text('[data-mr="OverviewZoomLevel"]').trim() !== "100%") throw new Error("not 100%"); });
    await ui.press("Escape"); // Esc goes back to the workspace you came from
    await ui.tags("OverviewCanvas", 0);
    await ui.key("Mod+0");
    await ui.tags("OverviewCanvas", 1);
    await ui.click("button", "Open Approve the event-log migration");
    await ui.tags("SessionName", 1);
    await ui.key("Mod+0");
    await ui.tags("OverviewCanvas", 1);
    // Coming back is a return: the camera is where you left it (100%), not refitted by an old ⌘0…
    await until("camera restored", () => { if (ui.text('[data-mr="OverviewZoomLevel"]').trim() !== "100%") throw new Error(ui.text('[data-mr="OverviewZoomLevel"]')); });
    await ui.key("Mod+0"); // …and ⌘0 on the Overview fits everything again
    await ui.css('[data-mr="OverviewCanvas"][data-fitted]', 1);
    await ui.click("button", "Open workspace Client X");
    await ui.tags("OverviewCanvas", 0);
    await ui.see("button", "Open Quarterly usage report");
    await ui.click("button", /^Overview/);
    await ui.click("button", "Open Overview canvas");
    await ui.tags("DocBlock", some);
  } },
  { name: "J19 a crowded Overview stays readable", run: async () => {
    await ui.open("workspaces-busy", { overview: true });
    await ui.tags("OverviewArea", 6);
    await ui.css('[data-mr="OverviewCanvas"][data-fitted]', 1);
    await until("fit is readable", () => { const z = parseInt(ui.text('[data-mr="OverviewZoomLevel"]'), 10); if (!(z >= 45)) throw new Error(`fit at ${z}%`); });
    await ui.see("button", "Open Approve the Acme deploy"); // what needs you is first, never hidden in +N more
    await ui.css('[data-mr="OverviewArea"][data-mr-source="ws_a"] [data-mr="OverviewBlock"]', 5); // 13 in progress: 5 shown…
    await until("+8 more", () => { if (!ui.text('[data-mr="OverviewMore"]').includes("+8 more")) throw new Error("no +N more"); });
    await ui.css('[data-mr="OverviewArea"][data-mr-source="ws_a"] [data-mr="OverviewGroup"]', 1); // …and no empty columns beside them
    await until("empty workspace says so", () => { if (!ui.text('[data-mr="OverviewArea"][data-mr-source="ws_e"]').includes("Nothing open")) throw new Error("no empty note"); });
    for (let i = 0; i < 8; i++) await ui.key("Shift+ArrowUp"); // ⇧↑ pans 400 px a step: off into empty canvas, whatever the window size…
    await ui.tags("OverviewLost", 1);
    await ui.click("button", /Back to your workspaces/); // …one button brings everything back
    await ui.tags("OverviewLost", 0);
    await ui.click("button", "8 more in In progress: open workspace Acme platform"); // +N more opens the workspace
    await ui.tags("OverviewCanvas", 0);
    await ui.see("button", /Acme task 12/);
  } },
  { name: "J18 move a session to another workspace", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("MoveWorkspace", 1);
    await ui.click("button", "Personal", '[data-mr="MoveWorkspace"]');
    await ui.click("menuitem", "Client A");
    await until("the session says Client A", () => { if (!ui.text('[data-mr="MoveWorkspace"] button').includes("Client A")) throw new Error("not moved"); });
    await ui.key("Escape"); // the app followed it: this is Client A's wall
    await ui.see("button", "Ready to review Refactor the settings schema");
    await ui.see("button", "Open Migrate the client's billing to Stripe Tax");
    await ui.click("button", "Personal");
    await ui.gone("button", "Ready to review Refactor the settings schema");
  } },
  { name: "J18 drag a session onto a workspace tab to move it", run: async () => {
    await ui.open("busy");
    const centre = (css: string) => {
      const b = Object.fromEntries([...pt("box", `css:${css}`).matchAll(/(\w+):(-?[\d.]+)/g)].map(([, k, v]) => [k, Number(v)]));
      return ["--x", String(b.x + b.width / 2), "--y", String(b.y + b.height / 2)];
    };
    const row = '[data-mr="ReviewRow"]';
    pt("scrollintoview", `css:${row}`);
    const from = centre(row), to = centre('[data-mr="WorkspaceTab"][data-mr-source="ws_client"]');
    pt("mouse", "move", ...from);
    pt("mouse", "down", ...from);
    pt("mouse", "move", "--x", String(Number(from[1]) + 20), "--y", from[3]);
    await ui.tags("SessionDragGhost", 1);
    pt("mouse", "move", ...to);
    await ui.css('[data-mr="WorkspaceTab"][data-mr-drop="on"][data-mr-source="ws_client"]', 1);
    pt("mouse", "up", ...to);
    await ui.tags("SessionDragGhost", 0);
    await ui.gone("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 0); // a drag isn't a click: the wall stays
    await ui.click("button", "Client A");
    await ui.see("button", "Ready to review Refactor the settings schema");
    await ui.click("button", "Ready to review Refactor the settings schema"); // a press still opens it
    await ui.tags("SessionName", 1);
  } },
  { name: "Errors light the error lamp", run: async () => {
    await ui.open("broken");
    await ui.see("button", "1 error");
  } },

  // Keyboard (MR-152): every shortcut PinchTab can press, in the scenario it applies to.
  { name: "Keys: ⌘K opens the picker from the wall and from a session, Esc closes it", run: async () => {
    await ui.open("busy");
    await ui.key("Mod+k");
    await ui.tags("KindTile", (c) => c >= 4);
    await ui.key("Escape");
    await ui.tags("KindTile", 0);
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 1);
    await ui.key("Mod+k");
    await ui.tags("KindTile", (c) => c >= 4);
    await ui.key("Escape");
    await ui.tags("KindTile", 0);
    await ui.tags("SessionName", 1); // the picker's Esc didn't also leave the session
  } },
  { name: "Keys: ⌘1–9 in the picker pick the kind of session", run: async () => {
    await ui.open("empty");
    await ui.key("Mod+k");
    await ui.css('[data-mr="KindTile"][aria-checked="true"]', 1);
    for (const n of [2, 3, 1]) {
      await ui.key(`Mod+${n}`);
      await ui.css(`[data-mr="KindTile"]:nth-child(${n})[aria-checked="true"]`, 1);
    }
  } },
  { name: "Keys: ⌘⇧A toggles the archive", run: async () => {
    await ui.open("archive");
    await ui.key("Mod+Shift+a");
    await ui.tags("Archive", 1);
    await ui.tags("ArchivedSession", 2);
    await ui.key("Mod+Shift+a");
    await ui.tags("Archive", 0);
  } },
  { name: "Keys: archive ↓/↑ move, Enter opens, Esc closes", run: async () => {
    await ui.open("archive");
    await ui.click("button", /^Archive/);
    await ui.tags("Archive", 1);
    const first = await until("a selected row", () => ui.selectedId("ArchivedSession"));
    await ui.key("ArrowDown");
    await until("selection moved down", () => { if (ui.selectedId("ArchivedSession") === first) throw new Error("didn't move"); });
    await ui.key("ArrowUp");
    await until("selection back up", () => { if (ui.selectedId("ArchivedSession") !== first) throw new Error("didn't move back"); });
    await ui.key("Escape");
    await ui.tags("Archive", 0);
    await ui.click("button", /^Archive/);
    await ui.key("Enter");
    await ui.tags("Archive", 0);
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: ⌘2 / ⌘1 switch workspaces, ⌘ with no such workspace does nothing", run: async () => {
    await ui.open("busy");
    await ui.key("Mod+2");
    await ui.see("button", "1 need you");
    await ui.key("Mod+3");
    await ui.see("button", "1 need you");
    await ui.key("Mod+1");
    await ui.see("button", "4 need you");
  } },
  { name: "Keys: ⌃Tab and ⌃⇧Tab cycle workspaces, wrapping", run: async () => {
    await ui.open("busy");
    await ui.key("Control+Tab");
    await ui.see("button", "1 need you");
    await ui.key("Control+Tab");
    await ui.see("button", "4 need you");
    await ui.key("Control+Shift+Tab");
    await ui.see("button", "1 need you");
  } },
  { name: "Keys: workspaces don't switch under an open dialog", run: async () => {
    await ui.open("busy");
    await ui.key("Mod+k");
    await ui.tags("KindTile", (c) => c >= 4);
    await ui.key("Control+Tab", "Mod+2", "Escape");
    await ui.see("button", "4 need you");
  } },
  { name: "Keys: ⌘J opens the switcher, ↓ Enter switches, Esc closes", run: async () => {
    await ui.open("busy");
    await ui.key("Mod+j");
    await ui.tags("WorkspaceSwitcher", 1);
    await ui.key("Escape");
    await ui.tags("WorkspaceSwitcher", 0);
    await ui.key("Mod+j");
    await ui.selected("WorkspaceOption");
    await ui.key("ArrowDown");
    await ui.css('[data-mr="WorkspaceOption"][data-mr-source="ws_client"][aria-current="true"]', 1);
    await ui.key("ArrowUp", "ArrowDown", "Enter");
    await ui.tags("WorkspaceSwitcher", 0);
    await ui.see("button", "1 need you");
  } },
  { name: "Keys: ⌘⇧G turns god mode on and off, Esc leaves it", run: async () => {
    await ui.open("busy");
    for (const off of ["Mod+Shift+g", "Escape"]) {
      await ui.key("Mod+Shift+g");
      await ui.css("[data-godmode-ui]", some);
      await ui.key(off);
      await ui.css("[data-godmode-ui]", 0);
    }
  } },
  { name: "Keys: T flips Wall ↔ Timeline, not while typing or inside a session", run: async () => {
    await ui.open("busy");
    await ui.key("t");
    await ui.tags("TimelineSummary", 1);
    await ui.key("t");
    await ui.tags("TimelineSummary", 0);
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 1);
    await ui.key("t");
    await sleep(300);
    await ui.tags("TimelineSummary", 0);
    await ui.key("Escape");
    await ui.tags("SessionName", 0);
    await ui.fill("Answer in your own words", "t");
    await sleep(300);
    await ui.tags("TimelineSummary", 0);
  } },
  { name: "Keys: Wall J/K move the selection across the queue and suggestions", run: async () => {
    await ui.open("busy");
    await ui.selected("DocQuestion");
    await ui.key("j", "j");
    await ui.selected("CommandCard");
    await ui.key("j");
    await ui.selected("QuestionCard");
    await ui.key("j");
    await ui.selected("Suggestion");
    for (let i = 0; i < 8; i++) await ui.key("j");
    await ui.selected("Suggestion"); // stops at the last row
    for (let i = 0; i < 10; i++) await ui.key("k");
    await ui.css('[data-mr="DocQuestion"][data-mr-source="doc1:b5"][aria-current="true"]', 1);
  } },
  { name: "Keys: Wall A allows the selected command", run: async () => {
    await ui.open("busy");
    await ui.key("a"); // a doc question is selected: A does nothing there
    await ui.tags("CommandCard", 1);
    await ui.key("j", "j", "a");
    await ui.tags("CommandCard", 0);
    await ui.see("button", "3 need you");
  } },
  { name: "Keys: Wall D denies the selected command", run: async () => {
    await ui.open("busy");
    await ui.key("j", "j", "d");
    await ui.tags("CommandCard", 0);
    await ui.see("button", "3 need you");
  } },
  { name: "Keys: Wall S skips the selected question", run: async () => {
    await ui.open("busy");
    await ui.key("j", "j", "j", "s");
    await ui.tags("QuestionCard", 0);
    await ui.see("button", "3 need you");
  } },
  { name: "Keys: Wall 1–9 answer the selected doc question, S skips one", run: async () => {
    await ui.open("busy");
    await ui.key("2");
    await ui.tags("DocQuestion", 1);
    await ui.see("button", "3 need you");
    await ui.key("s");
    await ui.tags("DocQuestion", 0);
    await ui.see("button", "2 need you");
  } },
  { name: "Keys: Wall Enter opens the selected row", run: async () => {
    await ui.open("busy");
    await ui.key("Enter");
    await ui.tags("DocBlock", some);
    await ui.key("Escape");
    await ui.tags("DocBlock", 0);
    await ui.key("j", "j", "Enter");
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: Wall Enter acts on a suggestion, X dismisses it", run: async () => {
    await ui.open("busy");
    await ui.tags("Suggestion", 2);
    await ui.key("j", "j", "j", "j", "j", "x");
    await ui.tags("Suggestion", 1);
    await ui.key("Enter");
    await ui.tags("Suggestion", 0);
  } },
  { name: "Keys: Wall keys stay off while typing or under the picker", run: async () => {
    await ui.open("busy");
    await ui.key("Mod+k");
    await ui.tags("KindTile", (c) => c >= 4);
    await ui.key("Escape");
    await ui.fill("Answer in your own words", "jjas");
    await ui.tags("CommandCard", 1);
    await ui.selected("DocQuestion");
  } },
  { name: "Keys: Esc leaves a session; with a draft it only leaves the box", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 1);
    await ui.fill("Message this session", "half a thought");
    pt("focus", ui.find("textbox", "Message this session").ref);
    await ui.key("Escape");
    await sleep(300);
    await ui.tags("SessionName", 1); // still here, draft kept
    await ui.key("Escape");
    await ui.tags("SessionName", 0);
  } },
  { name: "Keys: ⌘R toggles the raw transcript", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.see("button", key("R", "Raw transcript"));
    await ui.key("Mod+r");
    await ui.see("button", key("R", "Visual"));
    await ui.key("Mod+r");
    await ui.see("button", key("R", "Raw transcript"));
  } },
  { name: "Keys: ⌘⇧D marks a finished session done", run: async () => {
    await ui.open("busy");
    await ui.see("button", "1 to review");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 1);
    await ui.key("Mod+Shift+d");
    await ui.see("button", "0 to review");
  } },
  { name: "Keys: ⌘⇧M opens the model picker, Esc closes only it", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 1);
    await ui.key("Mod+Shift+m");
    await ui.css('[role="dialog"][aria-label="Model and effort"]', 1);
    await ui.key("Escape");
    await ui.css('[role="dialog"][aria-label="Model and effort"]', 0);
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: ⌘⇧U catches me up on a session", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.tags("SessionName", 1);
    await ui.key("Mod+Shift+u");
    await ui.tags("DocBlock", some);
  } },
  { name: "Keys: doc map Space walks, ←/→ step, O and Esc go back to the overview, Esc again leaves", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Open map ↵");
    await ui.css('[data-mr="DocStep"][data-mr-source="0"]', 1);
    await ui.key(" ");
    await ui.css('[data-mr="DocStep"][data-mr-source="1"]', 1);
    await ui.key("ArrowRight", "ArrowRight");
    await ui.css('[data-mr="DocStep"][data-mr-source="3"]', 1);
    await ui.key("ArrowLeft");
    await ui.css('[data-mr="DocStep"][data-mr-source="2"]', 1);
    await ui.key("o");
    await ui.css('[data-mr="DocStep"][data-mr-source="0"]', 1);
    await ui.key("ArrowRight", "Escape");
    await ui.css('[data-mr="DocStep"][data-mr-source="0"]', 1);
    await ui.key("Escape");
    await ui.tags("DocBlock", 0);
  } },
  { name: "Keys: doc map ⌘↵ sends the notes", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Open map ↵");
    await ui.click("button", "Open Scope");
    await ui.fill("Note on this block", "Include refunds too");
    await ui.press("Enter");
    await ui.see("button", /Regenerate with 1 change$/);
    await ui.key("Mod+Enter");
    await ui.seeText("Changed in v3");
  } },
  { name: "Keys: timeline Enter handles the top waiting item", run: async () => {
    await ui.open("timeline");
    await ui.key("t");
    await ui.tags("TimelineSummary", 1);
    await ui.see("button", /^↵ Handle/);
    await ui.key("Enter");
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: Settings ←/→ cycle tabs, Esc closes", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Settings");
    await ui.tags("Look", 1);
    const first = pt("attr", 'css:[data-mr="SettingsTab"][aria-selected="true"]', "data-mr-source").trim();
    pt("press", ui.find("tab", "Look", '[aria-label="Settings sections"]').ref, "ArrowRight"); // focuses the tab list first
    await until("next tab", () => { if (pt("attr", 'css:[data-mr="SettingsTab"][aria-selected="true"]', "data-mr-source").trim() === first) throw new Error("same tab"); });
    await ui.key("ArrowLeft");
    await until("back to the first tab", () => { if (pt("attr", 'css:[data-mr="SettingsTab"][aria-selected="true"]', "data-mr-source").trim() !== first) throw new Error("not back"); });
    await ui.key("Escape");
    await ui.tags("SettingsTab", 0);
  } },
  { name: "Keys: intro → / ← step through, Esc skips it", run: async () => {
    await ui.open("fresh");
    await ui.css('[data-mr="Onboarding"][data-mr-source="The wall"]', 1);
    await ui.key("ArrowRight");
    await ui.css('[data-mr="Onboarding"][data-mr-source="Pictures"]', 1);
    await ui.key("ArrowRight", "ArrowLeft");
    await ui.css('[data-mr="Onboarding"][data-mr-source="Pictures"]', 1);
    await ui.key("Escape");
    await ui.tags("Onboarding", 0);
  } },
  { name: "Keys: intro A / D answer its demo permission", run: async () => {
    for (const [k, after] of [["a", "Pushing…"], ["d", "Okay, pushing to a branch instead"]]) {
      await ui.open("fresh");
      await ui.see("button", "A Allow");
      await ui.key(k);
      await ui.gone("button", "A Allow");
      await ui.seeText(after);
    }
  } },
  { name: "Keys: intro Enter on the last step closes it", run: async () => {
    await ui.open("fresh");
    for (let i = 0; i < 5; i++) await ui.key("ArrowRight");
    await ui.css('[data-mr="Onboarding"][data-mr-source="Go"]', 1);
    await ui.key("Enter");
    await ui.tags("Onboarding", 0);
    // With no sessions yet the wall's own quick start takes over; how often to ask comes first.
    await ui.tags("PermissionPrompt", 1);
  } },
  { name: "Keys: permission prompt Enter picks Only when it's risky", run: async () => {
    await ui.open("permissions");
    await ui.tags("PermissionPrompt", 1);
    await ui.key("Enter");
    await ui.tags("PermissionPrompt", 0);
  } },
  { name: "Keys: Esc on the Never ask disclaimer keeps asking", run: async () => {
    await ui.open("permissions");
    await ui.clickCss('[data-mr="PermissionOption"][data-mr-source="never"]');
    await ui.tags("NeverAskDisclaimer", 1);
    await ui.key("Escape");
    await ui.tags("NeverAskDisclaimer", 0);
    await ui.tags("PermissionPrompt", 1);
  } },
  { name: "Keys: review overview J/K move, Enter opens a point, N raises it", run: async () => {
    await ui.open("review-overview");
    await ui.click("button", "↵ Continue review");
    await ui.tags("ReviewOverview", 1);
    await ui.css('[data-mr="ReviewPoint"][data-mr-source$=":0"][aria-current="true"]', 1);
    await ui.key("j");
    await ui.css('[data-mr="ReviewPoint"][data-mr-source$=":1"][aria-current="true"]', 1);
    await ui.key("k");
    await ui.css('[data-mr="ReviewPoint"][data-mr-source$=":0"][aria-current="true"]', 1);
    await ui.key("Enter");
    await ui.see("button", "N Raise it in the review");
    await ui.key("n");
    await ui.see("button", "N Raised ✓ · undo");
    await ui.key("Enter");
    await ui.gone("button", /^N Raise/);
  } },
  { name: "Keys: review overview Space starts the walkthrough", run: async () => {
    await ui.open("review-overview");
    await ui.click("button", "↵ Continue review");
    await ui.see("button", /^space Start walkthrough/);
    await ui.key(" ");
    await ui.gone("button", /^space Start walkthrough/);
  } },
  { name: "Keys: review snippet 1–9 note findings, Space asks for the next one", run: async () => {
    await ui.open("review");
    await ui.click("button", "↵ Continue review");
    await ui.see("button", "1 Note it");
    await ui.key("1");
    await ui.see("button", "1 Noted ✓ · undo");
    await ui.key("1");
    await ui.see("button", "1 Note it");
    await ui.key(" ");
    await ui.seeText("Snippet 2 of 3"); // the demo draws it at once
  } },
  { name: "Keys: review ← / → look back at a snippet and return", run: async () => {
    await ui.open("review");
    await ui.click("button", "↵ Continue review");
    await ui.see("button", "space Next snippet");
    await ui.key("ArrowRight"); // snippet 2 isn't drawn yet: asks Claude for it
    await ui.seeText("Snippet 2 of 3");
    await ui.key("ArrowLeft"); // back to snippet 1, looking back
    await ui.seeText("Snippet 1 of 3");
    await ui.see("button", /^space Back to snippet 2/);
    await ui.key(" "); // Space returns to where Claude is
    await ui.see("button", "space Next snippet");
  } },
  { name: "Keys: address a / b / c pick a fix for the thread", run: async () => {
    await ui.open("address");
    await ui.click("button", "↵ Continue");
    await ui.see("button", /^a Stream with a cursor/);
    await ui.key("b");
    await ui.see("button", /^export\.ts:30 .*queued/);
  } },
  { name: "Keys: Esc in the review-changes view goes back to the session, J/K switch files", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.clickUntil("button", "Review", '[data-mr="ChangeMap"]', "ReviewChanges");
    await ui.tags("ReviewChanges", 1);
    await ui.key("j");
    await ui.key("k");
    await ui.key("Escape");
    await ui.tags("ReviewChanges", 0);
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: ⌘↵ in review-changes sends the line notes", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.clickUntil("button", "Review", '[data-mr="ChangeMap"]', "ReviewChanges");
    await ui.clickCss('[data-mr="DiffView"] > div:nth-child(2) > div');
    await ui.fill("Note on line", "Guard against a missing user");
    await ui.press("Enter");
    await ui.see("button", /Send 1 note$/);
    await ui.key("Mod+Enter");
    await ui.tags("Toast", some);
  } },
  { name: "Keys: ⌥1–3 send a suggested reply", run: async () => {
    await ui.open("view");
    await ui.click("button", "Open Where are we on the settings refactor?");
    await ui.see("button", /^Add the shim/);
    await ui.key("Alt+2");
    await ui.tags("UserText", some);
    await until("the reply was sent", () => { if (!ui.text('[data-mr="UserText"]').includes("Bump the minimum version")) throw new Error("not in the transcript"); });
  } },
  { name: "Keys: lightbox ← / → page, 0 fits, Esc closes", run: async () => {
    await ui.open("view");
    await ui.click("button", "Open Where are we on the settings refactor?");
    await ui.click("button", "Open inline image");
    await ui.tags("Lightbox", 1);
    await ui.css('[data-mr="LightboxIndex"][data-mr-source="0"]', 1);
    await ui.key("ArrowRight");
    await ui.css('[data-mr="LightboxIndex"][data-mr-source="1"]', 1);
    await ui.key("ArrowLeft");
    await ui.css('[data-mr="LightboxIndex"][data-mr-source="0"]', 1);
    const b = Object.fromEntries([...pt("box", "css:[data-mr=Lightbox] img").matchAll(/(\w+):(-?[\d.]+)/g)].map(([, k, v]) => [k, Number(v)]));
    pt("mouse", "move", "--x", String(b.x + b.width / 2), "--y", String(b.y + b.height / 2));
    pt("mouse", "wheel", "--dy", "-400");
    await ui.css('[data-mr="LightboxZoom"]:not([data-mr-source="100"])', 1);
    await ui.key("0");
    await ui.css('[data-mr="LightboxZoom"][data-mr-source="100"]', 1);
    await ui.key("Escape");
    await ui.tags("Lightbox", 0);
    await ui.tags("SessionName", 1); // Esc closed the lightbox, not the session
  } },
  { name: "Keys: lightbox A / R give a verdict, C goes to the comment, Esc there only leaves it", run: async () => {
    await ui.open("view");
    await ui.click("button", "Open Where are we on the settings refactor?");
    await ui.clickUntil("button", "Open inline image", '[data-mr="ImageGallery"]', "Lightbox");
    await ui.tags("LightboxNotes", 1);
    const verdict = (v: string) => until(`verdict ${v}`, () => { if (!ui.text('[data-mr="LightboxNotes"] [data-mr="VerdictTag"]').includes(v)) throw new Error("other verdict"); });
    await ui.key("a");
    await verdict("Approved");
    await ui.key("r");
    await verdict("Rejected");
    await ui.key("c", "a"); // typing in the comment: A is a letter there, not Approve
    await sleep(200);
    await verdict("Rejected");
    await ui.key("Escape");
    await ui.tags("Lightbox", 1);
    await ui.key("Escape");
    await ui.tags("Lightbox", 0);
  } },
  { name: "Keys: lightbox P / D / W / B pick the tool, U undoes a mark", run: async () => {
    await ui.open("view");
    await ui.click("button", "Open Where are we on the settings refactor?");
    await ui.clickUntil("button", "Open inline image", '[data-mr="ImageGallery"]', "Lightbox");
    for (const [k, label] of [["d", "Draw"], ["w", "Arrow"], ["b", "Box"], ["p", "Pin"]]) {
      await ui.key(k);
      await until(`${label} picked`, () => { if (!ui.text('[data-mr="LightboxNotes"] [aria-pressed="true"]').includes(label)) throw new Error("other tool"); });
    }
    const b = Object.fromEntries([...pt("box", "css:[data-mr=Lightbox] img").matchAll(/(\w+):(-?[\d.]+)/g)].map(([, k, v]) => [k, Number(v)]));
    // A box (B, picked last but one) is a mark Undo can take back; a pin is a note with its own ×.
    await ui.key("b");
    const from = ["--x", String(b.x + b.width / 4), "--y", String(b.y + b.height / 4)];
    const to = ["--x", String(b.x + b.width / 2), "--y", String(b.y + b.height / 2)];
    pt("mouse", "move", ...from);
    pt("mouse", "down", ...from);
    pt("mouse", "move", ...to);
    pt("mouse", "up", ...to);
    pt("press", "Enter"); // leaves the new box's label field
    await sleep(200);
    await ui.see("button", "u Undo");
    await ui.key("u");
    await ui.gone("button", "u Undo");
  } },
  { name: "Keys: message box Enter sends, ↑ on an empty box recalls it", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.fill("Message this session", "Add a changelog entry");
    pt("press", ui.find("textbox", "Message this session").ref, "Enter");
    await until("the message was sent", () => { if (!ui.text('[data-mr="UserText"]').includes("Add a changelog entry")) throw new Error("not in the transcript"); });
    await until("box cleared", () => { if (pt("text", "css:[data-mr=PromptBox] textarea").trim()) throw new Error("box not empty"); });
    pt("press", ui.find("textbox", "Message this session").ref, "ArrowUp");
    await until("history recalled", () => { if (!pt("html", "css:[data-mr=PromptBox] textarea").includes("Add a changelog entry")) throw new Error("not recalled"); });
  } },
  { name: "Keys: / opens the command menu, Esc closes it without leaving the session", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    const box = ui.find("textbox", "Message this session").ref;
    pt("press", box, "/");
    await ui.tags("SlashMenu", 1);
    await ui.key("ArrowDown", "Escape");
    await ui.tags("SlashMenu", 0);
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: /mcp opens the MCP panel, Esc closes it", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.fill("Message this session", "/mcp");
    pt("press", ui.find("textbox", "Message this session").ref, "Enter");
    await ui.tags("McpPanel", 1);
    await ui.key("Escape");
    await ui.tags("McpPanel", 0);
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: picker ↓ / Enter pick a PR to address", run: async () => {
    await ui.open("busy");
    await ui.key("Mod+k");
    await ui.click("radio", "Address");
    await ui.see("button", "#479 Billing CSV export");
    await ui.key("Enter"); // the first PR is selected
    await ui.tags("AskRepo", 1);
  } },
  { name: "Keys: Enter in the quick start starts a session", run: async () => {
    await ui.open("empty");
    await ui.key("x"); // the weekly suggestion hides the quick start
    await ui.tags("QuickStart", 1);
    await ui.fill("What should Claude do?", "Add a health check endpoint");
    pt("press", ui.find("textbox", "What should Claude do?").ref, "Enter");
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: god mode ⌘↵ saves the mark and starts a fix", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Report a bug");
    await ui.fill("What's wrong", "Archive opens empty");
    pt("press", ui.find("textbox", "What's wrong").ref, MOD + "Enter");
    await ui.see("button", "Fix: Archive opens empty");
  } },
  { name: "Keys: ⌘⌥⇧B opens the builds, Esc closes them", run: async () => {
    await ui.open("busy");
    await ui.key("Mod+Alt+Shift+b");
    await ui.tags("Builds", 1);
    await ui.key("Escape");
    await ui.tags("Builds", 0);
  } },
  { name: "Keys: ⌘⇧B updates the app from main", run: async () => {
    await ui.open("busy&update=1");
    await ui.css('[data-mr="UpdateBanner"]', 1);
    const before = pt("attr", 'css:[data-mr="UpdateBanner"]', "data-mr-source").trim();
    await ui.key("Mod+Shift+b");
    await until("the update started", () => { if (pt("attr", 'css:[data-mr="UpdateBanner"]', "data-mr-source").trim() === before) throw new Error(`still ${before}`); });
  } },
  // MR-153: an expired sign-in says so, offers Claude's own sign-in, and sends the refused message again.
  { name: "J4 Expired sign-in: send the refused message again", run: async () => {
    await ui.open("signedout");
    await ui.see("button", "sign in");
    await ui.clickUntil("button", /Fix the flaky export test/, undefined, "SignedOut");
    await ui.see("button", "Sign in…");
    await ui.click("button", "Already signed in");
    await ui.seeText("Got it: now run the whole suite");
    await ui.tags("SignedOut", 0);
  } },
  { name: "J3 Expired sign-in waits in the needs-you queue", run: async () => {
    await ui.open("signedout");
    await ui.tags("SignInWaiting", 1);
    await ui.see("button", "1 need you");
    await ui.click("button", "Already signed in", '[data-mr="SignInWaiting"]');
    await ui.tags("SignInWaiting", 0);
  } },
  { name: "Keys: ⌘T toggles a session's terminal", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.see("button", key("T", "Open in terminal"));
    await ui.key("Mod+t");
    await ui.see("button", key("T", "Back to visual"));
    await ui.key("Mod+t");
    await ui.see("button", key("T", "Open in terminal"));
  } },
  { name: "Keys: Shift+Enter is a new line, not a send", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    await ui.fill("Message this session", "first line");
    pt("press", ui.find("textbox", "Message this session").ref, "Shift+Enter");
    await sleep(300);
    await ui.tags("UserText", 0);
    await until("the draft is still there", () => { if (!pt("html", "css:[data-mr=PromptBox] textarea").includes("first line")) throw new Error("draft gone"); });
  } },
  { name: "Keys: Tab completes a slash command", run: async () => {
    await ui.open("busy");
    await ui.click("button", "Ready to review Refactor the settings schema");
    pt("press", ui.find("textbox", "Message this session").ref, "/");
    await ui.tags("SlashMenu", 1);
    await ui.key("Tab");
    await ui.tags("SlashMenu", 0);
    await until("a command filled in", () => { if (!/\/\w+/.test(pt("html", "css:[data-mr=PromptBox] textarea"))) throw new Error("no command in the box"); });
    await ui.tags("SessionName", 1);
  } },
  { name: "Keys: Esc closes the delete-workspace dialog", run: async () => {
    await ui.open("busy");
    await ui.rightClick("button", "Client A");
    await ui.click("menuitem", "Delete workspace…");
    await ui.tags("DeleteWorkspace", 1);
    await ui.key("Escape");
    await ui.tags("DeleteWorkspace", 0);
    await ui.see("button", "Client A");
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
