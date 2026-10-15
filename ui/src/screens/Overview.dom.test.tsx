// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { replay } from "../state/reduce";
import type { MrEvent } from "../state/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

// The real Overview mounted in a DOM, driven by the events a Mac trackpad and mouse send. The pinch
// handler once read the gesture scale after overwriting it, so every step zoomed 1× and pinch did
// nothing in the app's WebKit view; pure-function tests couldn't see that, this does.
let n = 0;
const ev = (kind: string, payload: Record<string, unknown>): MrEvent => ({ id: `E${String(++n).padStart(5, "0")}`, session_id: null, kind, payload, anchor: null, created_at: n });
const state = replay([ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" })]);

let root: Root | null = null, host: HTMLDivElement;
const observers: (() => void)[] = [];
const win = { w: 0, h: 0 };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A ResizeObserver the test can fire, and a window size it controls (happy-dom lays nothing out).
  (globalThis as Record<string, unknown>).ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} };
  Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, left: 0, top: 0, width: win.w, height: win.h, right: win.w, bottom: win.h, toJSON() {} } as DOMRect; };
});
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); win.w = 0; win.h = 0; observers.length = 0; });

async function mount() {
  vi.resetModules(); // a fresh module: the remembered camera starts at 100%
  const { Overview } = await import("./Overview");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Overview state={state} docs={[]} fitSignal={0} onBack={() => {}} onOpenWorkspace={() => {}} onOpenSession={() => {}} onOpenDoc={() => {}} />));
  const canvas = host.querySelector('[data-mr="OverviewCanvas"]')!;
  const zoom = () => host.querySelector('[data-mr="OverviewZoomLevel"]')!.textContent;
  const fire = (type: string, props: Record<string, unknown> = {}) => act(() => { canvas.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), props)); });
  // happy-dom's WheelEvent drops ctrlKey / metaKey from its init, so they're set on the event itself.
  const wheel = ({ ctrlKey = false, metaKey = false, ...init }: WheelEventInit) => act(() => {
    const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    Object.defineProperties(e, { ctrlKey: { value: ctrlKey }, metaKey: { value: metaKey } });
    canvas.dispatchEvent(e);
  });
  return { zoom, fire, wheel };
}

describe("Overview input in a DOM", () => {
  it("a WebKit trackpad pinch zooms in and out with the gesture", async () => {
    const { zoom, fire } = await mount();
    expect(zoom()).toBe("100%");
    fire("gesturestart", { scale: 1, clientX: 0, clientY: 0 });
    for (const scale of [1.1, 1.3, 1.5]) fire("gesturechange", { scale, clientX: 0, clientY: 0 });
    fire("gestureend", { scale: 1.5 });
    expect(zoom()).toBe("150%");
    fire("gesturestart", { scale: 1 });
    fire("gesturechange", { scale: 0.5, clientX: 0, clientY: 0 });
    fire("gestureend", { scale: 0.5 });
    expect(zoom()).toBe("75%");
  });
  it("a ctrl+wheel that comes with a live pinch doesn't zoom twice", async () => {
    const { zoom, fire, wheel } = await mount();
    fire("gesturestart", { scale: 1 });
    fire("gesturechange", { scale: 1.2, clientX: 0, clientY: 0 });
    wheel({ deltaY: -20, ctrlKey: true });
    expect(zoom()).toBe("120%");
    fire("gestureend", { scale: 1.2 });
    wheel({ deltaY: -10, ctrlKey: true }); // after the gesture, ctrl+wheel (Chromium's pinch) zooms
    expect(zoom()).toBe(`${Math.round(120 * Math.exp(0.1))}%`);
  });
  it("one ⌘-scroll mouse notch is one gentle step; a plain wheel pans and leaves the zoom", async () => {
    const { zoom, wheel } = await mount();
    wheel({ deltaY: -100, metaKey: true });
    expect(zoom()).toBe(`${Math.round(100 * Math.exp(0.15))}%`);
    wheel({ deltaY: 300 });
    expect(zoom()).toBe(`${Math.round(100 * Math.exp(0.15))}%`);
  });
  it("+ and − on the keyboard zoom; Esc goes back", async () => {
    const onBack = vi.fn();
    const { Overview } = await import("./Overview");
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<Overview state={state} docs={[]} fitSignal={0} onBack={onBack} onOpenWorkspace={() => {}} onOpenSession={() => {}} onOpenDoc={() => {}} />));
    const before = host.querySelector('[data-mr="OverviewZoomLevel"]')!.textContent;
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", code: "Equal", shiftKey: true })); });
    expect(host.querySelector('[data-mr="OverviewZoomLevel"]')!.textContent).not.toBe(before);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape" })); });
    expect(onBack).toHaveBeenCalledOnce();
  });
  it("a window that gets its size late fits once, but never undoes a zoom you already made", async () => {
    const { zoom } = await mount(); // measured 0 × 0: a hidden window
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", code: "Minus" })); });
    expect(zoom()).toBe("80%");
    win.w = 1280; win.h = 800;
    act(() => observers.forEach((cb) => cb()));
    expect(zoom()).toBe("80%"); // your zoom stands
    expect(host.querySelector('[data-mr="OverviewCanvas"]')!.hasAttribute("data-fitted")).toBe(false);
  });
  it("untouched, it fits as soon as the window has a size", async () => {
    const { zoom } = await mount();
    win.w = 400; win.h = 400;
    act(() => observers.forEach((cb) => cb()));
    expect(zoom()).not.toBe("100%");
    expect(host.querySelector('[data-mr="OverviewCanvas"]')!.hasAttribute("data-fitted")).toBe(true);
  });
});

// Pointer and navigation fixes from the independent audit (MR-157 pass 11).
describe("Overview pointer and navigation in a DOM", () => {
  const busy = replay([
    ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
    { ...ev("ui.session_requested", { prompt: "Fix login", cwd: "/w", workspace: "personal" }), session_id: "s1" },
    { ...ev("sidecar.session_started", { sdk_session_id: "sdk", model: "m" }), session_id: "s1" },
  ]);
  type Props = { fitSignal?: number; state?: typeof busy };
  const spies = { back: vi.fn(), ws: vi.fn(), session: vi.fn() };
  let Overview: typeof import("./Overview").Overview;
  const render = (p: Props = {}) => act(() => root!.render(<Overview state={p.state ?? busy} docs={[]} fitSignal={p.fitSignal ?? 0} onBack={spies.back} onOpenWorkspace={spies.ws} onOpenSession={spies.session} onOpenDoc={() => {}} />));
  async function open(p: Props = {}, fresh = true) {
    if (fresh) { vi.resetModules(); Overview = (await import("./Overview")).Overview; }
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    render(p);
  }
  const $ = (css: string) => host.querySelector<HTMLElement>(css)!;
  const camera = () => $(".mr-ov-cam").style.transform;
  const zoom = () => $('[data-mr="OverviewZoomLevel"]').textContent;
  // happy-dom's PointerEvent drops most of its init: set what the handlers read on the event itself.
  const ptr = (el: Element, type: string, x: number, y: number, button = 0) => act(() => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(e, { clientX: { value: x }, clientY: { value: y }, button: { value: button }, pointerId: { value: 1 } });
    el.dispatchEvent(e);
  });
  const dragFrom = (el: Element, dx: number, dy: number, button = 0) => { ptr(el, "pointerdown", 100, 100, button); ptr(el, "pointermove", 100 + dx / 2, 100 + dy / 2, button); ptr(el, "pointermove", 100 + dx, 100 + dy, button); ptr(el, "pointerup", 100 + dx, 100 + dy, button); };
  const key = (k: string, type = "keydown") => act(() => { window.dispatchEvent(new KeyboardEvent(type, { key: k, code: k === " " ? "Space" : k, bubbles: true })); });
  const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  afterEach(() => { spies.back.mockReset(); spies.ws.mockReset(); spies.session.mockReset(); vi.restoreAllMocks(); });

  it("a drag that starts on a block moves its workspace and opens nothing", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await open();
    const block = $('[data-mr="OverviewBlock"]');
    dragFrom(block, 120, 0);
    click(block);
    expect(spies.session).not.toHaveBeenCalled();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("overview_move", expect.objectContaining({ workspace: "personal" }));
    click(block); // the next real click goes through
    expect(spies.session).toHaveBeenCalledWith("personal", "s1");
  });
  it("with Space held or the middle button, a drag over a workspace pans instead of moving it", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    await open();
    const area = $('[data-mr="OverviewArea"]');
    const before = camera();
    key(" ");
    dragFrom(area, 0, 80);
    key(" ", "keyup");
    const afterSpace = camera();
    expect(afterSpace).not.toBe(before);
    dragFrom(area, 60, 0, 1);
    expect(camera()).not.toBe(afterSpace);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("overview_move", expect.anything());
  });
  it("the second click of a double-click on a far-out workspace doesn't open it", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    win.w = 1280; win.h = 800;
    await open();
    act(() => observers.forEach((cb) => cb()));
    for (let i = 0; i < 12 && $('[data-mr="OverviewCanvas"]').dataset.zoom !== "far"; i++) key("-");
    expect($('[data-mr="OverviewCanvas"]').dataset.zoom).toBe("far");
    click($('[aria-label^="Zoom to workspace Personal"]'));
    expect($('[data-mr="OverviewCanvas"]').dataset.zoom).not.toBe("far");
    click($('[aria-label^="Open workspace Personal"]'));
    expect(spies.ws).not.toHaveBeenCalled();
    now += 500;
    click($('[aria-label^="Open workspace Personal"]'));
    expect(spies.ws).toHaveBeenCalledWith("personal");
  });
  it("coming back after a fit request returns to where you left it; a new request fits again", async () => {
    win.w = 1280; win.h = 800;
    await open({ fitSignal: 1 });
    act(() => observers.forEach((cb) => cb()));
    const fitted = zoom();
    key("+");
    const mine = zoom();
    expect(mine).not.toBe(fitted);
    act(() => root!.unmount()); host.remove();
    await open({ fitSignal: 1 }, false); // same module: the remembered camera
    act(() => observers.forEach((cb) => cb()));
    expect(zoom()).toBe(mine);
    render({ fitSignal: 2 });
    expect(zoom()).toBe(fitted);
  });
  it("Esc that closes a right-click menu doesn't also leave the Overview", async () => {
    await open();
    const menu = document.createElement("div");
    menu.setAttribute("data-mr-menu", "");
    document.body.appendChild(menu);
    key("Escape");
    expect(spies.back).not.toHaveBeenCalled();
    menu.remove();
    key("Escape");
    expect(spies.back).toHaveBeenCalledOnce();
  });
  it("a dropped workspace stays put while the other workspaces' spots replay in first", async () => {
    await open();
    const area = () => $('[data-mr="OverviewArea"][data-mr-source="personal"]');
    dragFrom(area(), 1600, 0); // far right: free canvas, so no nudge
    const dropped = { left: area().style.left, top: area().style.top };
    // Only Client B's event has come back so far.
    const b = $('[data-mr="OverviewArea"][data-mr-source="ws_b"]');
    render({ state: { ...busy, overviewLayout: { ws_b: { x: parseFloat(b.style.left), y: parseFloat(b.style.top) } } } });
    expect({ left: area().style.left, top: area().style.top }).toEqual(dropped);
  });
  it("Space-drag pans even after a press on the map left a button focused (Chromium), and doesn't press it", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    await open();
    const block = $('[data-mr="OverviewBlock"]');
    ptr(block, "pointerdown", 100, 100); ptr(block, "pointerup", 100, 100); // a plain press: Chromium focuses the button
    act(() => block.focus());
    // …and makes it match :focus-visible as soon as a key is down, so that can't tell press from Tab.
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, sel: string) { return sel === ":focus-visible" ? true : Element.prototype.closest.call(this, sel) === this; });
    const z = zoom(), before = camera();
    act(() => { block.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true })); });
    dragFrom($('[data-mr="OverviewArea"]'), 0, 80);
    const up = new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true });
    act(() => { block.dispatchEvent(up); });
    expect(camera()).not.toBe(before); // panned
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("overview_move", expect.anything()); // nothing moved or saved
    expect(up.defaultPrevented).toBe(true); // the focused button isn't pressed
    expect(zoom()).toBe(z);
  });
  it("a button reached with Tab keeps its Space, even after an earlier press on the map", async () => {
    await open();
    const out = $('[aria-label="Zoom out"]');
    ptr($('[data-mr="OverviewBlock"]'), "pointerdown", 100, 100); ptr($('[data-mr="OverviewBlock"]'), "pointerup", 100, 100);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); }); // Tab: focus by keyboard now
    out.focus();
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, sel: string) { return sel === ":focus-visible" ? true : Element.prototype.closest.call(this, sel) === this; });
    const down = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    act(() => { out.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(false);
  });
  it("zooming across a detail level keeps keyboard focus on that workspace", async () => {
    win.w = 1280; win.h = 800;
    await open();
    act(() => observers.forEach((cb) => cb()));
    for (let i = 0; i < 12 && $('[data-mr="OverviewCanvas"]').dataset.zoom !== "far"; i++) key("-");
    const far = $('[aria-label^="Zoom to workspace Client B"]');
    act(() => far.focus());
    for (let i = 0; i < 12 && $('[data-mr="OverviewCanvas"]').dataset.zoom === "far"; i++) key("+");
    expect(document.activeElement).toBe($('[data-mr="OverviewHeader"][data-mr-source="ws_b"]'));
  });
  // Where a workspace sits on screen: its canvas spot through the current camera transform.
  const onScreen = (ws: string) => {
    const m = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(camera())!;
    const [cx, cy, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const a = $(`[data-mr="OverviewArea"][data-mr-source="${ws}"]`);
    return { x: parseFloat(a.style.left) * z + cx, y: parseFloat(a.style.top) * z + cy };
  };
  it("a workspace being dragged stays under the cursor when the wheel scrolls mid-drag", async () => {
    win.w = 1280; win.h = 800;
    await open();
    act(() => observers.forEach((cb) => cb()));
    const area = $('[data-mr="OverviewArea"][data-mr-source="personal"]');
    const at = onScreen("personal");
    const gx = at.x + 30, gy = at.y + 20; // grab 30, 20 into it
    ptr(area, "pointerdown", gx, gy); ptr(area, "pointermove", gx + 40, gy); ptr(area, "pointermove", gx + 60, gy);
    const before = onScreen("personal");
    act(() => { $('[data-mr="OverviewCanvas"]').dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true, cancelable: true })); });
    const after = onScreen("personal");
    expect(after.x).toBeCloseTo(before.x, 5); // the camera moved, the workspace didn't leave the hand
    expect(after.y).toBeCloseTo(before.y, 5);
    ptr(area, "pointerup", gx + 60, gy);
  });
  it("held near the edge, a dragged workspace pans the canvas that way and stays in hand", async () => {
    vi.useFakeTimers();
    try {
      win.w = 1280; win.h = 800;
      await open();
      act(() => observers.forEach((cb) => cb()));
      const area = $('[data-mr="OverviewArea"][data-mr-source="personal"]');
      const at = onScreen("personal");
      ptr(area, "pointerdown", at.x + 30, at.y + 20); ptr(area, "pointermove", at.x + 60, at.y + 20);
      ptr(area, "pointermove", 1270, at.y + 20); // within 40 px of the right edge
      const cam0 = camera(), held0 = onScreen("personal");
      act(() => { vi.advanceTimersByTime(160); });
      expect(camera()).not.toBe(cam0); // the canvas scrolled
      expect(onScreen("personal").x).toBeCloseTo(held0.x, 5); // the workspace stayed under the cursor
      ptr(area, "pointermove", 640, at.y + 20); // back from the edge: it stops
      const cam1 = camera();
      act(() => { vi.advanceTimersByTime(160); });
      expect(camera()).toBe(cam1);
      ptr(area, "pointerup", 640, at.y + 20);
    } finally { vi.useRealTimers(); }
  });
  it("dragged out past the bottom of the window, the canvas keeps panning, like on the other edges", async () => {
    vi.useFakeTimers();
    try {
      win.w = 1280; win.h = 800;
      await open();
      act(() => observers.forEach((cb) => cb()));
      const area = $('[data-mr="OverviewArea"][data-mr-source="personal"]');
      const at = onScreen("personal");
      ptr(area, "pointerdown", at.x + 30, at.y + 20); ptr(area, "pointermove", at.x + 60, at.y + 20);
      ptr(area, "pointermove", 640, 900); // below the window (800 tall): the pointer is captured
      const cam0 = camera();
      act(() => { vi.advanceTimersByTime(160); });
      expect(camera()).not.toBe(cam0);
      ptr(area, "pointerup", 640, 900);
    } finally { vi.useRealTimers(); }
  });
  it("a dropped workspace lands on the 16-unit grid", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    await open();
    dragFrom($('[data-mr="OverviewArea"][data-mr-source="personal"]'), 1603, 7); // far right: free canvas, no nudge
    const call = vi.mocked(invoke).mock.calls.find(([c, a]) => c === "overview_move" && (a as { workspace: string }).workspace === "personal")!;
    const { x, y } = call[1] as { x: number; y: number };
    expect([x % 16, y % 16]).toEqual([0, 0]);
  });
  it("Tidy up shows once something was placed by hand, forgets the layout, and Undo puts it back", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    await open();
    expect(host.querySelector('[data-mr="OverviewTidy"]')).toBeNull(); // nothing placed: nothing to tidy
    const placed = { ...busy, overviewLayout: { personal: { x: 1600, y: 0 }, ws_b: { x: 0, y: 400 } } };
    render({ state: placed });
    click($('[data-mr="OverviewTidy"]'));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("overview_tidy");
    render({ state: { ...busy, overviewLayout: {} } }); // the tidy event replayed
    expect(host.querySelector('[data-mr="OverviewTidy"]')).toBeNull();
    click($('[data-mr="OverviewUndoTidy"]'));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("overview_move", { workspace: "personal", x: 1600, y: 0 });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("overview_move", { workspace: "ws_b", x: 0, y: 400 });
    expect(host.querySelector('[data-mr="OverviewUndoTidy"]')).toBeNull();
  });
  it("after Tidy up the workspaces are back in the auto grid, not held where they were dragged", async () => {
    await open({ state: { ...busy, overviewLayout: { personal: { x: 1600, y: 0 } } } });
    expect($('[data-mr="OverviewArea"][data-mr-source="personal"]').style.left).toBe("1600px");
    click($('[data-mr="OverviewTidy"]'));
    render({ state: { ...busy, overviewLayout: {} } });
    expect($('[data-mr="OverviewArea"][data-mr-source="personal"]').style.left).toBe("0px");
  });
  it("/ finds on the map: non-matches dim, Enter flies to the hit at 100%, Esc closes and stays on the map", async () => {
    win.w = 1280; win.h = 800;
    await open();
    act(() => observers.forEach((cb) => cb()));
    for (let i = 0; i < 4; i++) key("-"); // zoomed out first
    vi.useFakeTimers();
    key("/");
    const input = $('[data-mr="OverviewFind"] input') as HTMLInputElement;
    expect(document.activeElement).not.toBe(input); // not yet: the "/" itself must not be typed into it
    act(() => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    expect(input).toBeTruthy();
    act(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(input, "fix"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect($('[data-mr="OverviewArea"][data-mr-source="ws_b"]').dataset.dim).toBe("true"); // Client B has no "fix"
    expect($('[data-mr="OverviewArea"][data-mr-source="personal"]').dataset.dim).toBeUndefined();
    expect($('[data-mr="OverviewFindCount"]').textContent).toBe("1 found");
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect($('[data-mr="OverviewFindCount"]').textContent).toBe("1 of 1");
    expect(zoom()).toBe("100%");
    expect($('[data-mr="OverviewBlock"]').dataset.current).toBe("true");
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(host.querySelector('[data-mr="OverviewFind"]')).toBeNull();
    expect(spies.back).not.toHaveBeenCalled();
    expect($('[data-mr="OverviewArea"][data-mr-source="ws_b"]').dataset.dim).toBeUndefined();
  });
  it("a find hit folded into +N more rings that row", async () => {
    win.w = 1280; win.h = 800;
    const crowd = replay([
      ...Array.from({ length: 9 }, (_, i) => [{ ...ev("ui.session_requested", { prompt: `task ${i}`, cwd: "/w", workspace: "personal" }), session_id: `t${i}` }, { ...ev("sidecar.session_started", { sdk_session_id: `sdk${i}`, model: "m" }), session_id: `t${i}` }]).flat(),
    ]);
    await open({ state: crowd });
    act(() => observers.forEach((cb) => cb()));
    key("/");
    const input = $('[data-mr="OverviewFind"] input') as HTMLInputElement;
    act(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(input, "task 8"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect($('[data-mr="OverviewArea"][data-mr-source="personal"]').dataset.current).toBeUndefined();
    expect($('[data-mr="OverviewMore"]').dataset.current).toBe("true"); // the "+N more" row it's folded into
  });
  // Find helpers for the audit fixes below.
  const typeFind = (q: string) => {
    key("/");
    const input = $('[data-mr="OverviewFind"] input') as HTMLInputElement;
    act(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(input, q); input.dispatchEvent(new Event("input", { bubbles: true })); });
    return input;
  };
  const enter = (input: HTMLInputElement, shiftKey = false) => act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true })); });
  it("Esc with find open closes find, wherever the focus is, and never leaves the Overview", async () => {
    await open();
    const input = typeFind("fix");
    act(() => input.blur()); // focus left the box (a click on the canvas or the bar)
    key("Escape");
    expect(host.querySelector('[data-mr="OverviewFind"]')).toBeNull();
    expect(spies.back).not.toHaveBeenCalled();
    key("Escape"); // find closed: now Esc goes back
    expect(spies.back).toHaveBeenCalledOnce();
  });
  it("a faded workspace fades once: its blocks aren't faded a second time inside it", async () => {
    const withB = replay([
      ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
      { ...ev("ui.session_requested", { prompt: "Fix login", cwd: "/w", workspace: "personal" }), session_id: "s1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk", model: "m" }), session_id: "s1" },
      { ...ev("ui.session_requested", { prompt: "Quarterly report", cwd: "/w", workspace: "ws_b" }), session_id: "s2" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk2", model: "m" }), session_id: "s2" },
    ]);
    await open({ state: withB });
    typeFind("fix"); // Personal has the hit; Client B has none
    const b = $('[data-mr="OverviewArea"][data-mr-source="ws_b"]');
    expect(b.dataset.dim).toBe("true");
    expect(b.querySelector('[data-mr="OverviewBlock"]')).not.toBeNull();
    expect(b.querySelector('[data-mr="OverviewBlock"][data-dim]')).toBeNull();
  });
  it("a drag after Tidy up takes Undo away, so Undo can't throw the new arrangement away", async () => {
    await open({ state: { ...busy, overviewLayout: { personal: { x: 1600, y: 0 } } } });
    click($('[data-mr="OverviewTidy"]'));
    render({ state: { ...busy, overviewLayout: {} } });
    expect(host.querySelector('[data-mr="OverviewUndoTidy"]')).not.toBeNull();
    dragFrom($('[data-mr="OverviewArea"][data-mr-source="ws_b"]'), 1600, 0);
    expect(host.querySelector('[data-mr="OverviewUndoTidy"]')).toBeNull();
  });
  it("⇧Enter first goes to the last hit; the ring stays on the same item when the hit list changes", async () => {
    const two = replay([
      { ...ev("ui.session_requested", { prompt: "alpha task", cwd: "/w", workspace: "personal" }), session_id: "a1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "s1", model: "m" }), session_id: "a1" },
      { ...ev("ui.session_requested", { prompt: "beta task", cwd: "/w", workspace: "personal" }), session_id: "b1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "s2", model: "m" }), session_id: "b1" },
    ]);
    await open({ state: two });
    const input = typeFind("task");
    expect($('[data-mr="OverviewFindCount"]').textContent).toBe("2 found");
    enter(input, true);
    expect($('[data-mr="OverviewFindCount"]').textContent).toBe("2 of 2");
    const ringed = () => host.querySelector<HTMLElement>('[data-mr="OverviewBlock"][data-current]')?.dataset.mrSource;
    const was = ringed();
    // A new hit appears ahead of it in the list: the ring stays on the same session.
    const three = replay([
      { ...ev("ui.session_requested", { prompt: "aardvark task", cwd: "/w", workspace: "personal" }), session_id: "z0" },
      { ...ev("sidecar.session_started", { sdk_session_id: "s0", model: "m" }), session_id: "z0" },
      ...[two].flatMap(() => []),
    ]);
    render({ state: { ...two, sessions: { z0: three.sessions.z0, ...two.sessions } } });
    expect(ringed()).toBe(was);
  });
  it("the find box is a search landmark and its count is announced", async () => {
    await open();
    typeFind("fix");
    expect($('[data-mr="OverviewFind"]').getAttribute("role")).toBe("search");
    const count = $('[data-mr="OverviewFindCount"]');
    expect([count.getAttribute("role"), count.getAttribute("aria-live")]).toEqual(["status", "polite"]);
    expect($('[data-mr="OverviewFindInput"]').getAttribute("aria-describedby")).toBe(count.id);
  });
  it("coming back, what's new or changed since you left is tagged, and the bar counts it", async () => {
    await open(); // first visit: nothing tagged
    expect(host.querySelector('[data-mr="OverviewChange"]')).toBeNull();
    act(() => root!.unmount()); host.remove(); // leave the Overview
    const later = replay([
      ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
      { ...ev("ui.session_requested", { prompt: "Fix login", cwd: "/w", workspace: "personal" }), session_id: "s1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk", model: "m" }), session_id: "s1" },
      { ...ev("sidecar.permission_request", { request_id: "p1", tool: "Bash", input: { command: "ls" } }), session_id: "s1" },
      { ...ev("ui.session_requested", { prompt: "Brand new job", cwd: "/w", workspace: "ws_b" }), session_id: "s2" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk2", model: "m" }), session_id: "s2" },
    ]);
    await open({ state: later }, false); // same module: it remembers what you saw
    const tag = (id: string) => host.querySelector<HTMLElement>(`[data-mr="OverviewBlock"][data-mr-source="${id}"]`)?.dataset.change;
    expect(tag("s1")).toBe("updated"); // started asking for permission meanwhile
    expect(tag("s2")).toBe("new");
    expect($('[data-mr="OverviewChanged"]').textContent).toBe("2 changed since you last looked");
    expect($('[data-mr="OverviewBlock"][data-mr-source="s2"]').getAttribute("aria-label")).toMatch(/new since you last looked$/);
    // The title leaves room for the tag in the corner instead of running under it.
    const right = (id: string) => parseFloat($(`[data-mr="OverviewBlock"][data-mr-source="${id}"]`).style.paddingRight);
    expect(right("s2")).toBeGreaterThan(50);
  });
  it("tags stand for what moved while you were away: changes you watch happen don't pile on", async () => {
    const base = replay([
      { ...ev("ui.session_requested", { prompt: "Fix login", cwd: "/w", workspace: "personal" }), session_id: "s1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk", model: "m" }), session_id: "s1" },
    ]);
    await open({ state: base });
    act(() => root!.unmount()); host.remove();
    await open({ state: base }, false); // back, nothing moved: quiet
    expect(host.querySelector('[data-mr="OverviewChange"]')).toBeNull();
    // Now, while you watch, it starts asking.
    const asking = replay([
      { ...ev("ui.session_requested", { prompt: "Fix login", cwd: "/w", workspace: "personal" }), session_id: "s1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk", model: "m" }), session_id: "s1" },
      { ...ev("sidecar.permission_request", { request_id: "p9", tool: "Bash", input: { command: "ls" } }), session_id: "s1" },
    ]);
    render({ state: asking });
    expect(host.querySelector('[data-mr="OverviewChange"]')).toBeNull();
    expect(host.querySelector('[data-mr="OverviewChanged"]')).toBeNull();
  });
  it("a workspace with changes says so by its name, also far out where no tags are drawn", async () => {
    win.w = 1280; win.h = 800;
    await open();
    act(() => root!.unmount()); host.remove();
    const later = replay([
      ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
      { ...ev("ui.session_requested", { prompt: "Fix login", cwd: "/w", workspace: "personal" }), session_id: "s1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk", model: "m" }), session_id: "s1" },
      { ...ev("ui.session_requested", { prompt: "Brand new job", cwd: "/w", workspace: "ws_b" }), session_id: "s2" },
      { ...ev("sidecar.session_started", { sdk_session_id: "sdk2", model: "m" }), session_id: "s2" },
    ]);
    await open({ state: later }, false);
    act(() => observers.forEach((cb) => cb()));
    expect($('[data-mr="OverviewAreaChanged"][data-mr-source="ws_b"]').textContent).toBe("● 1 changed"); // a word and a dot, not a "+ 1"
    for (let i = 0; i < 12 && $('[data-mr="OverviewCanvas"]').dataset.zoom !== "far"; i++) key("-");
    expect($('[data-mr="OverviewAreaChanged"][data-mr-source="ws_b"]').textContent).toBe("● 1");
  });
  it("what you did inside a workspace isn't reported back as news; what happened elsewhere is", async () => {
    const both = (personalAsks: boolean, bAsks: boolean) => replay([
      ev("ui.workspace_created", { id: "ws_b", name: "Client B", config_dir: "/x" }),
      { ...ev("ui.session_requested", { prompt: "Mine", cwd: "/w", workspace: "personal" }), session_id: "m1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "a", model: "m" }), session_id: "m1" },
      ...(personalAsks ? [{ ...ev("sidecar.permission_request", { request_id: "pm", tool: "Bash", input: {} }), session_id: "m1" }] : []),
      { ...ev("ui.session_requested", { prompt: "Theirs", cwd: "/w", workspace: "ws_b" }), session_id: "t1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "b", model: "m" }), session_id: "t1" },
      ...(bAsks ? [{ ...ev("sidecar.permission_request", { request_id: "pt", tool: "Bash", input: {} }), session_id: "t1" }] : []),
    ]);
    await open({ state: both(false, false) });
    act(() => root!.unmount()); host.remove(); // into Personal…
    const after = both(true, true); // …where your session moved on while you watched; Client B's moved on its own
    const { markWorkspaceSeen } = await import("./Overview");
    markWorkspaceSeen(after, [], "personal"); // on the way out of Personal
    await open({ state: after }, false);
    const tag = (id: string) => host.querySelector<HTMLElement>(`[data-mr="OverviewBlock"][data-mr-source="${id}"]`)?.dataset.change;
    expect(tag("m1")).toBeUndefined();
    expect(tag("t1")).toBe("updated");
    expect($('[data-mr="OverviewChanged"]').textContent).toBe("1 changed since you last looked");
    expect($('[data-mr="OverviewHeader"][data-mr-source="ws_b"]').getAttribute("aria-label")).toMatch(/1 changed since you last looked$/);
  });
  it("in a session, only that session counts as seen: another one changing behind it keeps its news", async () => {
    const two = (asks: boolean) => replay([
      { ...ev("ui.session_requested", { prompt: "The one I had open", cwd: "/w", workspace: "personal" }), session_id: "open1" },
      { ...ev("sidecar.session_started", { sdk_session_id: "a", model: "m" }), session_id: "open1" },
      { ...ev("ui.session_requested", { prompt: "The one behind it", cwd: "/w", workspace: "personal" }), session_id: "behind" },
      { ...ev("sidecar.session_started", { sdk_session_id: "b", model: "m" }), session_id: "behind" },
      ...(asks ? [{ ...ev("sidecar.permission_request", { request_id: "q1", tool: "Bash", input: {} }), session_id: "open1" }, { ...ev("sidecar.permission_request", { request_id: "q2", tool: "Bash", input: {} }), session_id: "behind" }] : []),
    ]);
    await open({ state: two(false) });
    act(() => root!.unmount()); host.remove();
    const after = two(true);
    const { markWorkspaceSeen } = await import("./Overview");
    markWorkspaceSeen(after, [], "personal", ["session:open1"]); // left the session you had open
    await open({ state: after }, false);
    const tag = (id: string) => host.querySelector<HTMLElement>(`[data-mr="OverviewBlock"][data-mr-source="${id}"]`)?.dataset.change;
    expect(tag("open1")).toBeUndefined();
    expect(tag("behind")).toBe("updated");
  });
});
