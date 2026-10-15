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
