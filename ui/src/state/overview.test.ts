import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replay } from "./reduce";
import { actualSize, anyInView, farSizes, LABEL_H, MIN_ZOOM, pinchCam, revealBy, wheelCam, AREA_GAP, AREA_W, areaHeight, columns, nearest, PAD, BLOCK_GAP, BLOCK_H, bounds, detail, fit, MAX_ROWS, overview, place, readable, settle, shown, zoomAt, type OverviewBlock } from "./overview";
import type { Doc } from "./docs";
import type { MrEvent } from "./types";

let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}, session: string | null = null): MrEvent => ({ id: `E${String(++n).padStart(5, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
const start = (id: string, workspace: string, prompt = id) => [ev("ui.session_requested", { prompt, cwd: "/w", workspace }, id), ev("sidecar.session_started", { sdk_session_id: `sdk-${id}`, model: "m" }, id)];
const todos = (id: string, done: number, total: number) => ev("sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "tool_use", id: `t${n}`, name: "TodoWrite", input: { todos: Array.from({ length: total }, (_, i) => ({ content: `step ${i + 1}`, activeForm: `Doing step ${i + 1}`, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) } }] } } }, id);
const result = (id: string, text = "ok") => ev("sidecar.sdk", { message: { type: "result", is_error: false, result: text } }, id);

// The real MR-2 probe session (sidecar/fixtures), replayed into the "ws_real" workspace.
function probe(): MrEvent[] {
  const raw = readFileSync(join(__dirname, "../../../sidecar/fixtures/probe.messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const out = [ev("ui.session_requested", { prompt: "probe", cwd: "/tmp/p", workspace: "ws_real" }, "probe")];
  for (const m of raw) {
    if (m.type === "system" && m.subtype === "init") out.push(ev("sidecar.session_started", { sdk_session_id: m.session_id, model: m.model }, "probe"));
    out.push(ev("sidecar.sdk", { message: m }, "probe"));
  }
  return out;
}

const doc = (id: string, session: string | null, extra: Partial<Doc> = {}): Doc => ({ id, title: id, session_id: session, version: 1, blocks: {}, pending_notes: [], pending_changes: [], ...extra });
const question = { q: { id: "q", section: "question", status: "draft", takeaway: "Which?", key: "", body: "", data: null, order: 0, decision: null, updated: "" } };

describe("Overview grouping (decision 40)", () => {
  const events = [
    ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
    ev("ui.workspace_created", { id: "ws_real", name: "Real", config_dir: "/y" }),
    ...start("run", "personal"), todos("run", 1, 3),
    ...start("ask", "personal"), ev("sidecar.permission_request", { request_id: "p1", tool: "Bash", input: { command: "rm -rf build" } }, "ask"),
    ...start("rev", "personal"), todos("rev", 3, 3), result("rev"),
    ...start("done", "personal"), todos("done", 2, 2), result("done"), ev("sidecar.session_ended", { ok: true }, "done"),
    ...start("open", "personal"), todos("open", 1, 3), result("open"), ev("sidecar.session_ended", { ok: true }, "open"),
    ...start("err", "ws_b"), ev("sidecar.session_ended", { ok: false, reason: "boom" }, "err"),
    ...start("arch", "ws_b"), result("arch"), ev("ui.session_archived", {}, "arch"),
    ...probe(),
  ];
  const state = replay(events);
  // An app restart interrupts what was mid-turn: here, by hand, so the test doesn't depend on owners.
  state.sessions.int = { ...state.sessions.run, id: "int", workspace: "ws_b", status: "interrupted" };
  const docs = [
    doc("drafting", "rev", { blocks: question }),
    doc("ready", "rev"),
    doc("shipped", null, { shipped_at: 5 }),
    doc("brief", "rev", { kind: "brief" }),
    doc("archivedOwner", "arch"),
  ];
  const areas = overview(state, docs, {});
  const area = (ws: string) => areas.find((a) => a.workspace === ws)!;
  const ids = (ws: string, g: "resume" | "progress" | "review") => area(ws).groups[g].map((b) => b.id);

  it("has one rectangle per workspace, in tab order", () => {
    expect(areas.map((a) => a.name)).toEqual(["Personal", "Client B", "Real"]);
  });
  it("puts running and waiting-on-you work in progress, what needs you first", () => {
    expect(ids("personal", "progress")[0]).toBe("ask");
    expect(ids("personal", "progress")).toEqual(expect.arrayContaining(["ask", "run", "drafting"]));
    expect(area("personal").groups.progress.find((b) => b.id === "ask")).toMatchObject({ needs: true, lamp: "needs_you", status: "Needs you" });
  });
  it("puts finished plans and ready or shipped docs in review", () => {
    expect(ids("personal", "review")).toEqual(["rev", "ready", "shipped"]);
  });
  it("puts errors, interruptions and sessions that ended with steps open in resume", () => {
    expect(ids("personal", "resume")).toEqual(["open"]);
    expect(ids("ws_b", "resume").sort()).toEqual(["err", "int"]);
    expect(area("personal").groups.resume[0].status).toBe("Ended with 2 steps open");
  });
  it("leaves done work off the map: clean ends, archived sessions and their docs, briefs", () => {
    const all = areas.flatMap((a) => Object.values(a.groups).flat().map((b) => b.id));
    for (const gone of ["done", "arch", "archivedOwner", "brief"]) expect(all).not.toContain(gone);
  });
  it("never shows the question text on the map", () => {
    const lines = areas.flatMap((a) => Object.values(a.groups).flat().map((b) => b.status));
    expect(lines.some((l) => /rm -rf|Which\?|Asks:/.test(l))).toBe(false);
  });
  it("counts beside the name: needs you from the Wall's own queue, then each group", () => {
    expect(area("personal").counts).toEqual({ needs: 2, resume: 1, progress: 3, review: 3 });
    expect(area("ws_b").counts).toEqual({ needs: 0, resume: 2, progress: 0, review: 0 });
  });
  it("places the real probe session (it ended its turn idle) in its own workspace", () => {
    const real = area("ws_real");
    expect(Object.values(real.groups).flat().map((b) => b.id)).toEqual(["probe"]);
  });
});

describe("Overview layout", () => {
  it("lines new workspaces up to the right in tab order in a wide viewport", () => {
    const at = place([{ workspace: "a", w: AREA_W, h: 100 }, { workspace: "b", w: AREA_W, h: 300 }], {}, 4);
    expect(at).toEqual({ a: { x: 0, y: 0 }, b: { x: AREA_W + AREA_GAP, y: 0 } });
  });
  it("packs workspaces into a grid shaped like the viewport, not one long row", () => {
    const four = ["a", "b", "c", "d"].map((workspace) => ({ workspace, w: AREA_W, h: 300 }));
    const at = place(four, {}, 16 / 10);
    // 2 × 2 on a laptop screen: the second row starts under the first, in tab order.
    expect(at).toEqual({ a: { x: 0, y: 0 }, b: { x: AREA_W + AREA_GAP, y: 0 }, c: { x: 0, y: 300 + AREA_GAP }, d: { x: AREA_W + AREA_GAP, y: 300 + AREA_GAP } });
    // A tall window stacks them; a very wide one keeps a single row.
    expect(new Set(Object.values(place(four, {}, 0.3)).map((p) => p.x))).toEqual(new Set([0]));
    expect(new Set(Object.values(place(four, {}, 8)).map((p) => p.y))).toEqual(new Set([0]));
  });
  it("fits three workspaces bigger than one row would (the canvas was unreadable at 51%)", () => {
    const three = ["a", "b", "c"].map((workspace) => ({ workspace, w: AREA_W, h: 260 }));
    const view = { w: 1280, h: 720 };
    const zoomOf = (at: Record<string, { x: number; y: number }>) => fit(bounds(three.map((s) => ({ ...s, ...at[s.workspace] }))), view).zoom;
    const row = Object.fromEntries(three.map((s, i) => [s.workspace, { x: i * (AREA_W + AREA_GAP), y: 0 }]));
    expect(zoomOf(place(three, {}, view.w / view.h))).toBeGreaterThan(zoomOf(row) + 0.15);
  });
  it("a row's height is its tallest workspace, so a short one never hides under a tall one", () => {
    const at = place([{ workspace: "a", w: AREA_W, h: 100 }, { workspace: "b", w: AREA_W, h: 500 }, { workspace: "c", w: AREA_W, h: 100 }], {}, 1.2);
    expect(at.c.y).toBeGreaterThanOrEqual(500 + AREA_GAP);
  });
  it("keeps dragged spots and puts a new workspace in the first free spot right of them", () => {
    const at = place([{ workspace: "a", w: AREA_W, h: 100 }, { workspace: "new", w: AREA_W, h: 100 }], { a: { x: 400, y: -200 } });
    expect(at.a).toEqual({ x: 400, y: -200 });
    expect(at.new).toEqual({ x: 400 + AREA_W + AREA_GAP, y: -200 });
  });
  it("replays ui.overview_moved into the layout, and drops it with the workspace", () => {
    const base = [ev("ui.workspace_created", { id: "ws_x", name: "X", config_dir: "/x" })];
    const moved = replay([...base, ev("ui.overview_moved", { workspace: "ws_x", x: 120, y: -40 }), ev("ui.overview_moved", { workspace: "personal", x: 900, y: 0 })]);
    expect(moved.overviewLayout).toEqual({ ws_x: { x: 120, y: -40 }, personal: { x: 900, y: 0 } });
    expect(overview(moved, [], moved.overviewLayout).find((a) => a.workspace === "ws_x")).toMatchObject({ x: 120, y: -40 });
    expect(replay([...base, ev("ui.overview_moved", { workspace: "ws_x", x: "nope", y: 1 })]).overviewLayout).toEqual({});
    const gone = replay([...base, ev("ui.overview_moved", { workspace: "ws_x", x: 1, y: 1 }), ev("ui.workspace_deleted", { id: "ws_x", name: "X" })]);
    expect(gone.overviewLayout).toEqual({});
  });
  it("fits everything in view, never zooming past 1", () => {
    const box = bounds([{ x: 0, y: 0, w: 2000, h: 400 }, { x: 0, y: 600, w: 100, h: 400 }]);
    expect(box).toEqual({ x: 0, y: 0, w: 2000, h: 1000 });
    const cam = fit(box, { w: 1096, h: 800 });
    expect(cam.zoom).toBeCloseTo(0.5);
    expect(fit({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 1000 }).zoom).toBe(1);
  });
  it("zooms around the cursor and switches detail by zoom", () => {
    const cam = zoomAt({ x: 0, y: 0, zoom: 1 }, 100, 100, 2);
    expect(cam).toEqual({ zoom: 2, x: -100, y: -100 });
    expect([detail(0.2), detail(0.6), detail(1)]).toEqual(["far", "middle", "close"]);
  });
});

describe("Overview drop and zoom text", () => {
  const a = { x: 0, y: 0, w: AREA_W, h: 300 };
  it("leaves a drop on free canvas where it was let go", () => {
    expect(settle({ x: 2000, y: 0, w: AREA_W, h: 200 }, [a])).toEqual({ x: 2000, y: 0 });
  });
  it("nudges a drop that covers another workspace to the nearest free spot beside it", () => {
    const spot = settle({ x: 600, y: 40, w: AREA_W, h: 200 }, [a]);
    expect(spot).toEqual({ x: AREA_W + AREA_GAP / 2, y: 40 }); // right of it: the shortest move
    const r = { ...spot, w: AREA_W, h: 200 };
    expect(r.x >= a.x + a.w || r.y >= a.y + a.h).toBe(true);
  });
  it("never settles onto a third workspace while dodging the second", () => {
    const b = { x: AREA_W + 40, y: 0, w: AREA_W, h: 300 };
    const spot = settle({ x: 300, y: 50, w: AREA_W, h: 200 }, [a, b]);
    for (const o of [a, b]) {
      const clear = spot.x >= o.x + o.w || spot.x + AREA_W <= o.x || spot.y >= o.y + o.h || spot.y + 200 <= o.y;
      expect(clear).toBe(true);
    }
  });
  it("prefers a free spot you can see over a nearer one out of view", () => {
    const drop = { x: 0, y: 60, w: AREA_W, h: 200 };
    expect(settle(drop, [a])).toEqual({ x: 0, y: 300 + AREA_GAP / 2 }); // below: the nearest
    // With the view's top edge at y = 0 and nothing visible to the left, the spot below still wins…
    const view = { x: -100, y: 0, w: 3000, h: 1000 };
    expect(settle(drop, [a], view)).toEqual({ x: 0, y: 300 + AREA_GAP / 2 });
    // …but scrolled so that "below" is off screen, it goes to the right, where you can see it.
    expect(settle(drop, [a], { x: 0, y: -50, w: 3000, h: 400 })).toEqual({ x: AREA_W + AREA_GAP / 2, y: 60 });
  });
  it("keeps text at least 12 px on screen when zoomed out, never shrinking it below its size", () => {
    expect(readable(14, 1)).toBe(14);
    expect(readable(14, 0.5) * 0.5).toBeCloseTo(12);
    expect(readable(14, 2)).toBe(14);
    expect(readable(14, 0.01)).toBe(14 * 4); // capped, so a far zoom doesn't blow it past the rectangle
  });
});

describe("Overview busy columns", () => {
  const b = (i: number): OverviewBlock => ({ kind: "session", id: `s${i}`, title: `s${i}`, lamp: "working", needs: false, status: "", step: null });
  const many = (k: number) => Array.from({ length: k }, (_, i) => b(i));
  it("shows a column whole up to the cap", () => {
    expect(shown(many(MAX_ROWS))).toEqual({ blocks: many(MAX_ROWS), more: 0 });
  });
  it("past the cap keeps the first ones (what needs you sorts first) and counts the rest as +N more", () => {
    const v = shown(many(12));
    expect(v.blocks.map((x) => x.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(v.more).toBe(7);
    expect(v.blocks.length + 1).toBe(MAX_ROWS); // the "+N more" row takes the last slot
  });
  it("a busy workspace is no taller than the cap, so it can't stretch the grid", () => {
    const groups = { resume: [], progress: many(30), review: [] };
    expect(areaHeight(groups)).toBe(areaHeight({ resume: [], progress: many(MAX_ROWS), review: [] }));
    expect(areaHeight(groups) - areaHeight({ resume: [], progress: many(MAX_ROWS - 1), review: [] })).toBe(BLOCK_H + BLOCK_GAP);
  });
});

describe("Overview columns", () => {
  const b = (id: string): OverviewBlock => ({ kind: "session", id, title: id, lamp: "working", needs: false, status: "", step: null });
  it("draws only the groups with something in them, in Resume / In progress / Review order", () => {
    expect(columns({ resume: [b("r")], progress: [], review: [b("v")] }).map((c) => c.group)).toEqual(["resume", "review"]);
    expect(columns({ resume: [], progress: [], review: [] })).toEqual([]);
  });
  it("a lone group gets the whole width, so its titles aren't cut to a third", () => {
    const [one] = columns({ resume: [], progress: [b("p")], review: [] });
    expect(one).toEqual({ group: "progress", x: PAD, w: AREA_W - PAD * 2 });
  });
  it("columns share the width edge to edge with a gap between", () => {
    const cols = columns({ resume: [b("r")], progress: [b("p")], review: [b("v")] });
    expect(cols[0].x).toBe(PAD);
    expect(cols[2].x + cols[2].w).toBeCloseTo(AREA_W - PAD);
    expect(cols[1].x - (cols[0].x + cols[0].w)).toBeCloseTo(BLOCK_GAP);
  });
});

describe("Overview 100%", () => {
  const a = { id: "a", x: 0, y: 0, w: 720, h: 300 }, b = { id: "b", x: 800, y: 0, w: 720, h: 300 }, c = { id: "c", x: 0, y: 380, w: 720, h: 900 };
  it("picks the workspace under the middle of the view, else the closest one", () => {
    expect(nearest([a, b, c], 100, 100)?.id).toBe("a");
    expect(nearest([a, b, c], 1100, 340)?.id).toBe("b"); // in the empty gap of a 2 × 2 grid: the closest
    expect(nearest([], 0, 0)).toBeNull();
  });
  it("lands at 100% with the workspace centred, or from its top when it's taller than the view", () => {
    expect(actualSize(b, { w: 1280, h: 700 })).toEqual({ zoom: 1, x: (1280 - 720) / 2 - 800, y: (700 - 300) / 2 });
    expect(actualSize(c, { w: 1280, h: 700 })).toEqual({ zoom: 1, x: (1280 - 720) / 2, y: 24 - 380 });
  });
});

describe("Overview reveal", () => {
  const view = { w: 1000, h: 600 };
  it("leaves the camera alone when the rectangle is in view", () => {
    expect(revealBy({ x: 100, y: 100, w: 200, h: 100 }, { x: 0, y: 0, zoom: 1 }, view)).toEqual({ dx: 0, dy: 0 });
  });
  it("pans just enough to bring an off-screen rectangle in, with a margin", () => {
    expect(revealBy({ x: 100, y: -80, w: 200, h: 100 }, { x: 0, y: 0, zoom: 1 }, view)).toEqual({ dx: 0, dy: 104 });
    expect(revealBy({ x: 900, y: 100, w: 200, h: 100 }, { x: 0, y: 0, zoom: 1 }, view)).toEqual({ dx: -124, dy: 0 });
  });
  it("works in canvas units at any zoom, and shows the top-left of one too big to fit", () => {
    expect(revealBy({ x: -100, y: 0, w: 100, h: 100 }, { x: 0, y: 50, zoom: 0.5 }, view)).toEqual({ dx: 74, dy: 0 });
    expect(revealBy({ x: 0, y: 700, w: 100, h: 2000 }, { x: 50, y: 0, zoom: 1 }, view).dy).toBe(24 - 700);
  });
});

describe("Overview lost in empty canvas", () => {
  const r = { x: 0, y: 0, w: 720, h: 300 }, view = { w: 1000, h: 600 };
  it("sees a rectangle that is on screen, even partly", () => {
    expect(anyInView([r], { x: 0, y: 0, zoom: 1 }, view)).toBe(true);
    expect(anyInView([r], { x: -700, y: 0, zoom: 1 }, view)).toBe(true);
  });
  it("knows when you've panned off into nothing", () => {
    expect(anyInView([r], { x: -800, y: 0, zoom: 1 }, view)).toBe(false);
    expect(anyInView([r], { x: 0, y: 700, zoom: 1 }, view)).toBe(false);
    expect(anyInView([r], { x: 1100, y: 0, zoom: 0.5 }, view)).toBe(false);
  });
});

describe("Overview wheel and pinch", () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  const w = (deltaX: number, deltaY: number, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; deltaMode: number }> = {}) => ({ deltaX, deltaY, ctrlKey: false, metaKey: false, ...mods });
  it("a plain wheel or two-finger scroll pans, both ways", () => {
    expect(wheelCam(cam, w(30, 200), 0, 0)).toEqual({ x: -30, y: -200, zoom: 1 });
  });
  it("line-mode wheels pan by 16 px a line", () => {
    expect(wheelCam(cam, w(0, 3, { deltaMode: 1 }), 0, 0).y).toBe(-48);
  });
  it("a trackpad pinch (ctrl+wheel, small deltas) is never clamped: the zoom tracks the fingers 1:1", () => {
    // Chromium sends a pinch as ctrl+wheel with deltaY ≈ −100·ln(scale): a few px an event.
    let c = cam;
    for (let i = 0; i < 20; i++) c = wheelCam(c, w(0, -100 * Math.log(1.02), { ctrlKey: true }), 0, 0);
    expect(c.zoom).toBeCloseTo(1.02 ** 20);
  });
  it("a trackpad pinch (ctrl+wheel, small deltas) zooms smoothly around the cursor", () => {
    const z = wheelCam(cam, w(0, -5, { ctrlKey: true }), 400, 300);
    expect(z.zoom).toBeCloseTo(Math.exp(0.05));
    expect((400 - z.x) / z.zoom).toBeCloseTo(400); // the point under the cursor stays put
  });
  it("one ⌘-scroll mouse notch is one gentle step, not a 2.7× jump", () => {
    const z = wheelCam(cam, w(0, -100, { metaKey: true }), 0, 0);
    expect(z.zoom).toBeCloseTo(Math.exp(0.15)); // 1.16×, near tldraw / Excalidraw's ~1.1× and the +/− step
    expect(wheelCam(cam, w(0, 100, { metaKey: true }), 0, 0).zoom).toBeCloseTo(Math.exp(-0.15));
  });
  it("while a WebKit pinch gesture is live, a ctrl+wheel with it doesn't zoom a second time", () => {
    expect(wheelCam(cam, w(0, -5, { ctrlKey: true }), 0, 0, true)).toBe(cam);
  });
  it("WebKit pinch zooms by the change in the gesture's cumulative scale", () => {
    // The bug this replaces read the new scale for both, so every step was 1× and pinch did nothing.
    let c = cam, prev = 1;
    for (const s of [1.1, 1.3, 1.5]) { c = pinchCam(c, s, prev, 0, 0); prev = s; }
    expect(c.zoom).toBeCloseTo(1.5);
    expect(pinchCam(cam, 0, 1, 0, 0)).toBe(cam);
  });
});

describe("Overview far view sizes", () => {
  const ONE_ROW = 180; // the shortest workspace: one row of blocks
  it("at the furthest zoom a one-row workspace keeps a 12 px name and 8 px lamps, all inside it", () => {
    const f = farSizes(ONE_ROW, MIN_ZOOM);
    expect(f.name * MIN_ZOOM).toBeGreaterThanOrEqual(12);
    expect(f.lamp * MIN_ZOOM).toBeGreaterThanOrEqual(8); // was ~5 px with a fixed share of the height
    expect(f.note * MIN_ZOOM).toBeGreaterThanOrEqual(8);
    expect(f.pad * 2 + f.name * 1.1 + f.gap + f.lamp).toBeLessThanOrEqual(ONE_ROW + 1e-9);
  });
  it("with room to spare, lamps stay a steady 10 px on screen", () => {
    expect(farSizes(1200, 0.3).lamp * 0.3).toBeCloseTo(10);
  });
});

describe("Overview text floor", () => {
  it("a column heading fits 12 px on screen right down to the far threshold", () => {
    const z = 0.45; // below this the far view takes over
    expect(Math.min(readable(12, z, 12), LABEL_H - BLOCK_GAP) * z).toBeGreaterThanOrEqual(12 - 0.01);
  });
  it("status lines near 100% never read under 12 px (a fit often lands at 90-99%)", () => {
    for (const z of [0.9, 0.93, 0.99, 1, 1.5]) expect(readable(12, z, 12) * z).toBeGreaterThanOrEqual(12 - 1e-9);
  });
});
