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
    wheel({ deltaY: -20, ctrlKey: true }); // after the gesture, ctrl+wheel (Chromium's pinch) zooms
    expect(zoom()).toBe(`${Math.round(120 * Math.exp(0.2))}%`);
  });
  it("one ⌘-scroll mouse notch is one gentle step; a plain wheel pans and leaves the zoom", async () => {
    const { zoom, wheel } = await mount();
    wheel({ deltaY: -100, metaKey: true });
    expect(zoom()).toBe(`${Math.round(100 * Math.exp(0.3))}%`);
    wheel({ deltaY: 300 });
    expect(zoom()).toBe(`${Math.round(100 * Math.exp(0.3))}%`);
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
  it("Space-drag pans even right after a mouse click focused a button, and doesn't press that button", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    await open();
    const out = $('[aria-label="Zoom out"]');
    click(out); out.focus(); // Chromium focuses a clicked button (not :focus-visible)
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, sel: string) { return sel === ":focus-visible" ? false : Element.prototype.closest.call(this, sel) === this; });
    const z = zoom(), before = camera();
    act(() => { out.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true })); });
    dragFrom($('[data-mr="OverviewArea"]'), 0, 80);
    const up = new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true });
    act(() => { out.dispatchEvent(up); });
    expect(camera()).not.toBe(before); // panned
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("overview_move", expect.anything()); // not moved and saved
    expect(up.defaultPrevented).toBe(true); // the focused button isn't pressed on the way up
    expect(zoom()).toBe(z);
  });
  it("a button focused from the keyboard keeps its Space", async () => {
    await open();
    const out = $('[aria-label="Zoom out"]');
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
});
