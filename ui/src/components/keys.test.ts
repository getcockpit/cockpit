import { afterEach, describe, expect, it } from "vitest";
import { appKey, focusKey, isTyping, keyOf, type KeyEv } from "./keys";
import { sendsOnEnter } from "./autoGrow";
import { setMac } from "../platform";

afterEach(() => setMac(null));

// A key event as the browser sends it: `key` is the typed character, `code` the physical key.
const CODES: Record<string, string> = { ",": "Comma", ".": "Period", " ": "Space", "/": "Slash" };
function ev(key: string, mods: Partial<KeyEv> & { defaultPrevented?: boolean } = {}) {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : CODES[key] ?? key;
  return { key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null, defaultPrevented: false, ...mods };
}
const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, closest: () => null, ...extra }) as unknown as EventTarget;
const inTerminal = { tagName: "TEXTAREA", value: "", closest: (s: string) => (s === ".xterm" ? {} : null) } as unknown as EventTarget;

describe("keyOf", () => {
  it("reads the physical key, so shortcuts work on any layout", () => {
    expect(keyOf({ code: "KeyK", key: "л" })).toBe("k");
    expect(keyOf({ code: "Digit3", key: "#" })).toBe("3");
    expect(keyOf({ code: "Comma", key: "б" })).toBe(",");
    expect(keyOf({ code: "Period", key: "ю" })).toBe(".");
    expect(keyOf({ code: "Space", key: " " })).toBe(" ");
    expect(keyOf({ code: "Slash", key: "." })).toBe("/");
    expect(keyOf({ code: "Escape", key: "Escape" })).toBe("Escape");
    expect(keyOf({ code: "", key: "Enter" })).toBe("Enter");
  });
});

describe("isTyping", () => {
  it("counts inputs, textareas and contentEditable", () => {
    expect(isTyping(el("INPUT"))).toBe(true);
    expect(isTyping(el("TEXTAREA"))).toBe(true);
    expect(isTyping(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTyping(el("BUTTON"))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe("sendsOnEnter", () => {
  const k = (key: string, shiftKey = false, isComposing = false) => ({ key, shiftKey, nativeEvent: { isComposing } }) as unknown as React.KeyboardEvent;
  it("sends on Enter, not Shift+Enter or mid-composition", () => {
    expect(sendsOnEnter(k("Enter"))).toBe(true);
    expect(sendsOnEnter(k("Enter", true))).toBe(false);
    expect(sendsOnEnter(k("Enter", false, true))).toBe(false);
    expect(sendsOnEnter(k("a"))).toBe(false);
  });
});

describe("app-wide shortcuts", () => {
  const wall = { workspaces: 3, screen: "wall" as const, dialog: false };
  for (const mac of [true, false]) {
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const name = mac ? "⌘" : "Ctrl+";
    it(`${name} opens the overlays (${mac ? "Mac" : "Linux/Windows"})`, () => {
      setMac(mac);
      expect(appKey(ev("k", mod), wall)).toEqual({ do: "picker" });
      expect(appKey(ev("g", { ...mod, shiftKey: true }), wall)).toEqual({ do: "god" });
      expect(appKey(ev(",", mod), wall)).toEqual({ do: "settings" });
      expect(appKey(ev("a", { ...mod, shiftKey: true }), wall)).toEqual({ do: "archive" });
      expect(appKey(ev("b", { ...mod, shiftKey: true }), wall)).toEqual({ do: "update" });
      expect(appKey(ev("b", { ...mod, shiftKey: true, altKey: true }), wall)).toEqual({ do: "builds" });
      expect(appKey(ev("j", mod), wall)).toEqual({ do: "switcher" });
    });
    it(`${name}1–9 switch to an existing workspace, unless a dialog is open`, () => {
      setMac(mac);
      expect(appKey(ev("1", mod), wall)).toEqual({ do: "workspace", index: 0 });
      expect(appKey(ev("3", mod), wall)).toEqual({ do: "workspace", index: 2 });
      expect(appKey(ev("4", mod), wall)).toBeNull();
      expect(appKey(ev("1", { ...mod, shiftKey: true }), wall)).toBeNull();
      expect(appKey(ev("1", mod), { ...wall, dialog: true })).toBeNull();
    });
    it(`${name}0 opens the Overview of every workspace, unless a dialog is open`, () => {
      setMac(mac);
      expect(appKey(ev("0", mod), wall)).toEqual({ do: "overview" });
      expect(appKey(ev("0", mod), { ...wall, screen: "focus" })).toEqual({ do: "overview" });
      expect(appKey(ev("0", { ...mod, shiftKey: true }), wall)).toBeNull();
      expect(appKey(ev("0", mod), { ...wall, dialog: true })).toBeNull();
      expect(appKey(ev("0"), wall)).toBeNull();
    });
    it(`${name} overlays still open from a text field and over a dialog`, () => {
      setMac(mac);
      const busy = { ...wall, screen: "focus" as const, dialog: true };
      expect(appKey(ev("k", { ...mod, target: el("TEXTAREA") }), busy)).toEqual({ do: "picker" });
      expect(appKey(ev(",", { ...mod, target: el("INPUT") }), busy)).toEqual({ do: "settings" });
    });
  }
  it("off a Mac, plain Ctrl in the terminal belongs to the shell, Ctrl+Shift doesn't", () => {
    setMac(false);
    expect(appKey(ev("k", { ctrlKey: true, target: inTerminal }), wall)).toBeNull();
    expect(appKey(ev("a", { ctrlKey: true, shiftKey: true, target: inTerminal }), wall)).toEqual({ do: "archive" });
  });
  it("on a Mac, Ctrl is not the command key", () => {
    setMac(true);
    expect(appKey(ev("k", { ctrlKey: true }), wall)).toBeNull();
    expect(appKey(ev("k"), wall)).toBeNull();
  });
  it("⌃Tab cycles workspaces (⌃ on every platform), backwards with Shift", () => {
    setMac(true);
    expect(appKey(ev("Tab", { ctrlKey: true }), wall)).toEqual({ do: "cycle", by: 1 });
    expect(appKey(ev("Tab", { ctrlKey: true, shiftKey: true }), wall)).toEqual({ do: "cycle", by: -1 });
    expect(appKey(ev("Tab", { ctrlKey: true }), { ...wall, workspaces: 1 })).toBeNull();
    expect(appKey(ev("Tab", { ctrlKey: true }), { ...wall, dialog: true })).toBeNull();
    expect(appKey(ev("Tab"), wall)).toBeNull();
  });
  it("T flips Wall ↔ Timeline only on the wall, not while typing or under a dialog", () => {
    setMac(true);
    expect(appKey(ev("t"), wall)).toEqual({ do: "wallView" });
    expect(appKey(ev("t", { target: el("INPUT") }), wall)).toBeNull();
    expect(appKey(ev("t", { target: el("DIV", { isContentEditable: true }) }), wall)).toBeNull();
    expect(appKey(ev("t"), { ...wall, screen: "focus" })).toBeNull();
    expect(appKey(ev("t"), { ...wall, screen: "doc" })).toBeNull();
    expect(appKey(ev("t"), { ...wall, dialog: true })).toBeNull();
    expect(appKey(ev("t", { altKey: true }), wall)).toBeNull();
    expect(appKey(ev("t", { metaKey: true }), wall)).toBeNull();
  });
});

describe("session (Focus) shortcuts", () => {
  const idle = { running: false, archived: false, fromDeleted: false, replies: 2, resumable: true, dialog: false };
  for (const mac of [true, false]) {
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    it(`${mac ? "⌘" : "Ctrl+"} combos (${mac ? "Mac" : "Linux/Windows"})`, () => {
      setMac(mac);
      expect(focusKey(ev(".", mod), { ...idle, running: true })).toEqual({ do: "interrupt" });
      expect(focusKey(ev(".", mod), idle)).toBeNull();
      expect(focusKey(ev("d", { ...mod, shiftKey: true }), idle)).toEqual({ do: "done" });
      expect(focusKey(ev("d", { ...mod, shiftKey: true }), { ...idle, archived: true })).toBeNull();
      expect(focusKey(ev("r", mod), idle)).toEqual({ do: "raw" });
      expect(focusKey(ev("m", { ...mod, shiftKey: true }), idle)).toEqual({ do: "model" });
      expect(focusKey(ev("u", { ...mod, shiftKey: true }), idle)).toEqual({ do: "catchUp" });
      expect(focusKey(ev("m", { ...mod, shiftKey: true }), { ...idle, fromDeleted: true })).toBeNull();
      expect(focusKey(ev("u", { ...mod, shiftKey: true }), { ...idle, fromDeleted: true })).toBeNull();
      expect(focusKey(ev("t", mod), idle)).toEqual({ do: "terminal" });
      expect(focusKey(ev("t", mod), { ...idle, resumable: false })).toBeNull();
    });
  }
  it("⌥1–3 send a suggested reply, only when it exists and nothing is running", () => {
    setMac(true);
    expect(focusKey(ev("1", { altKey: true }), idle)).toEqual({ do: "reply", index: 0 });
    expect(focusKey(ev("2", { altKey: true }), idle)).toEqual({ do: "reply", index: 1 });
    expect(focusKey(ev("3", { altKey: true }), idle)).toBeNull();
    expect(focusKey(ev("1", { altKey: true }), { ...idle, running: true })).toBeNull();
    expect(focusKey(ev("1"), idle)).toBeNull();
  });
  it("Esc goes back, leaves a draft without losing it, and yields to dialogs, menus and the terminal", () => {
    setMac(true);
    expect(focusKey(ev("Escape"), idle)).toEqual({ do: "back" });
    expect(focusKey(ev("Escape", { target: el("TEXTAREA", { value: "" }) }), idle)).toEqual({ do: "back" });
    expect(focusKey(ev("Escape", { target: el("TEXTAREA", { value: "half a thought" }) }), idle)).toEqual({ do: "blur" });
    expect(focusKey(ev("Escape"), { ...idle, dialog: true })).toBeNull();
    expect(focusKey(ev("Escape", { defaultPrevented: true }), idle)).toBeNull();
    expect(focusKey(ev("Escape", { target: inTerminal }), idle)).toBeNull();
  });
  it("off a Mac, Ctrl+R and Ctrl+T inside the terminal stay the shell's", () => {
    setMac(false);
    expect(focusKey(ev("r", { ctrlKey: true, target: inTerminal }), idle)).toBeNull();
    expect(focusKey(ev("t", { ctrlKey: true, target: inTerminal }), idle)).toBeNull();
    expect(focusKey(ev("d", { ctrlKey: true, shiftKey: true, target: inTerminal }), idle)).toEqual({ do: "done" });
  });
});
