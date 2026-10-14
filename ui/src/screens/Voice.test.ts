import { expect, test } from "vitest";
import { TAP_MS, voiceKey, type VoiceKey, type VoiceMode } from "./Voice";

const k = (type: "down" | "up", code: string, key: string, at: number, extra: Partial<VoiceKey> = {}): VoiceKey =>
  ({ type, code, key, alt: code === "Space" || key === "Alt", repeat: false, at, ...extra });
const talkDown = (at: number) => k("down", "Space", " ", at);
const talkUp = (at: number) => k("up", "Space", " ", at);

// Run keys through the state machine, as the controller does: pressedAt is set on "start".
function run(keys: VoiceKey[], mode: VoiceMode = "idle") {
  let pressedAt = 0;
  const acts: string[] = [];
  for (const key of keys) {
    const s = voiceKey(mode, pressedAt, key);
    if (s.act === "start") pressedAt = key.at;
    if (s.act) acts.push(s.act);
    mode = s.mode;
  }
  return { mode, acts };
}

test("holding ⌥ Space is push-to-talk: release sends", () => {
  expect(run([talkDown(0), k("down", "Space", " ", 50, { repeat: true }), talkUp(900)])).toEqual({ mode: "stopping", acts: ["start", "stop"] });
});

test("a quick tap keeps listening hands-free; the Alt release after it changes nothing", () => {
  expect(run([talkDown(0), talkUp(TAP_MS - 1), k("up", "AltLeft", "Alt", TAP_MS + 20)])).toEqual({ mode: "hands-free", acts: ["start"] });
});

test("hands-free: another tap, or Enter, sends", () => {
  expect(run([talkDown(0), talkUp(100), talkDown(5000)]).acts).toEqual(["start", "stop"]);
  const enter = voiceKey("hands-free", 0, k("down", "Enter", "Enter", 5000, { alt: false }));
  expect(enter).toEqual({ mode: "stopping", act: "stop", swallow: true });
});

test("Esc cancels while listening, and is left alone otherwise", () => {
  expect(voiceKey("hands-free", 0, k("down", "Escape", "Escape", 10, { alt: false })).act).toBe("cancel");
  expect(voiceKey("hold", 0, k("down", "Escape", "Escape", 10, { alt: false })).act).toBe("cancel");
  expect(voiceKey("idle", 0, k("down", "Escape", "Escape", 10, { alt: false })).swallow).toBe(false);
});

test("Enter types normally unless hands-free; ⌥ Space while sending starts nothing", () => {
  expect(voiceKey("idle", 0, k("down", "Enter", "Enter", 0, { alt: false })).swallow).toBe(false);
  expect(voiceKey("hold", 0, k("down", "Enter", "Enter", 0, { alt: false })).swallow).toBe(false);
  expect(voiceKey("stopping", 0, talkDown(0))).toEqual({ mode: "stopping", swallow: true });
});
