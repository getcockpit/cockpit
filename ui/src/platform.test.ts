import { afterEach, describe, expect, it } from "vitest";
import { detect, isMac, keyLabel, modKey, setMac } from "./platform";
import { comboOf } from "./state/usage";

const ev = (mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}, target: unknown = null) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, target: target as EventTarget | null, ...mods });
// Stands in for an element inside (or outside) the xterm pane.
const inTerminal = { closest: (sel: string) => (sel === ".xterm" ? {} : null) };
const elsewhere = { closest: () => null };

afterEach(() => setMac(null));

describe("platform", () => {
  it("reads the platform from the navigator", () => {
    expect(detect({ platform: "MacIntel" })).toBe(true);
    expect(detect({ userAgentData: { platform: "macOS" }, platform: "" })).toBe(true);
    expect(detect({ platform: "Linux x86_64" })).toBe(false);
    expect(detect({ userAgentData: { platform: "Windows" } })).toBe(false);
    expect(detect({ platform: "Win32" })).toBe(false);
    expect(detect({})).toBe(true);
    setMac(false);
    expect(isMac()).toBe(false);
  });

  it("leaves labels alone on a Mac", () => {
    setMac(true);
    expect(keyLabel("⌘⇧D")).toBe("⌘⇧D");
    expect(keyLabel("⌘-click to go deeper")).toBe("⌘-click to go deeper");
  });

  it("spells shortcuts out with Ctrl / Alt / Shift elsewhere", () => {
    setMac(false);
    expect(keyLabel("⌘K")).toBe("Ctrl+K");
    expect(keyLabel("⌘⇧D")).toBe("Ctrl+Shift+D");
    expect(keyLabel("⌘⌥⇧B")).toBe("Ctrl+Alt+Shift+B");
    expect(keyLabel("⌘↵")).toBe("Ctrl+Enter");
    expect(keyLabel("⌘.")).toBe("Ctrl+.");
    expect(keyLabel("⌥2")).toBe("Alt+2");
    expect(keyLabel("⌥Space")).toBe("Alt+Space");
    expect(keyLabel("release ⌥ Space to send")).toBe("release Alt+Space to send");
    expect(keyLabel("⌘-click to go deeper")).toBe("Ctrl-click to go deeper");
    expect(keyLabel("try me: right-click · ⌘-click · ⌥-click")).toBe("try me: right-click · Ctrl-click · Alt-click");
    expect(keyLabel("Open Builds (⌘⇧B) for the log.")).toBe("Open Builds (Ctrl+Shift+B) for the log.");
    expect(keyLabel("Add it any time in Settings (⌘,).")).toBe("Add it any time in Settings (Ctrl+,).");
    expect(keyLabel("↑↓ pick · ⌃Tab next workspace · ⌘1–9 direct")).toBe("↑↓ pick · Ctrl+Tab next workspace · Ctrl+1–9 direct");
  });

  it("takes ⌘ on a Mac and Ctrl elsewhere as the command key", () => {
    setMac(true);
    expect(modKey(ev({ metaKey: true }))).toBe(true);
    expect(modKey(ev({ ctrlKey: true }))).toBe(false);
    setMac(false);
    expect(modKey(ev({ ctrlKey: true }, elsewhere))).toBe(true);
    expect(modKey(ev({ metaKey: true }))).toBe(false);
  });

  it("leaves plain Ctrl to the shell inside the terminal off a Mac", () => {
    setMac(false);
    expect(modKey(ev({ ctrlKey: true }, inTerminal))).toBe(false);
    expect(modKey(ev({ ctrlKey: true, shiftKey: true }, inTerminal))).toBe(true);
    setMac(true);
    expect(modKey(ev({ metaKey: true }, inTerminal))).toBe(true);
  });

  it("records Ctrl shortcuts as the same ⌘ combos off a Mac", () => {
    setMac(false);
    const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean }>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code, key: code, ...mods });
    expect(comboOf(key("KeyK", { ctrlKey: true }), false)).toBe("⌘K");
    expect(comboOf(key("KeyG", { ctrlKey: true, shiftKey: true }), false)).toBe("⇧⌘G");
    expect(comboOf(key("KeyV", { ctrlKey: true }), true)).toBeNull();
  });
});
