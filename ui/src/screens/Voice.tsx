import { shortError } from "../components/ErrorLine";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../state/listen";
import { keyLabel } from "../platform";

// Push-to-talk (MR-18) and point + talk (MR-19). Hold ⌥ Space and speak; release to stop.
// Or tap ⌥ Space (MR-146): it keeps listening hands-free until another tap or Enter sends; Esc cancels.
// Where the words go:
//   1. an input or text area that had focus when you started → typed into it;
//   2. otherwise, if you were pointing at something (data-mr) → sent to that thing's session with
//      what you pointed at attached;
//   3. otherwise → onFallback (the start picker opens with the text).

export type PointTarget = { component: string; source: string; text: string };
type Resolve = (t: PointTarget) => { session: string; label: string } | null;

function pointed(el: Element | null): PointTarget | null {
  const t = el?.closest?.("[data-mr]") as HTMLElement | null;
  if (!t) return null;
  return { component: t.dataset.mr ?? "", source: t.dataset.mrSource ?? "", text: (t.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 400) };
}

// How a key moves push-to-talk along (MR-146). A ⌥ Space shorter than TAP_MS is a tap: listening
// stays on hands-free. Kept pure so the timing rules are tested without a microphone.
export const TAP_MS = 300;
export type VoiceMode = "idle" | "hold" | "hands-free" | "stopping";
export type VoiceKey = { type: "down" | "up"; code: string; key: string; alt: boolean; repeat: boolean; at: number };
export type VoiceStep = { mode: VoiceMode; act?: "start" | "stop" | "cancel"; swallow: boolean };

export function voiceKey(mode: VoiceMode, pressedAt: number, k: VoiceKey): VoiceStep {
  const talkKey = k.alt && k.code === "Space";
  if (k.type === "down") {
    // Swallow every ⌥ Space, auto-repeats included: on macOS each one would type a non-breaking
    // space into the focused field while the user holds the keys to talk.
    if (talkKey) {
      if (k.repeat) return { mode, swallow: true };
      if (mode === "idle") return { mode: "hold", act: "start", swallow: true };
      if (mode === "hands-free") return { mode: "stopping", act: "stop", swallow: true };
      return { mode, swallow: true };
    }
    if (mode === "hands-free" && k.key === "Enter") return { mode: "stopping", act: "stop", swallow: true };
    if ((mode === "hands-free" || mode === "hold") && k.key === "Escape") return { mode: "stopping", act: "cancel", swallow: true };
    return { mode, swallow: false };
  }
  if (mode !== "hold" || (k.code !== "Space" && k.key !== "Alt")) return { mode, swallow: false };
  if (k.at - pressedAt < TAP_MS) return { mode: "hands-free", swallow: true };
  return { mode: "stopping", act: "stop", swallow: true };
}

export function VoiceController({ resolve, send, onFallback, onCatchUp }: { resolve: Resolve; send: (session: string, text: string) => void; onFallback: (text: string) => void; onCatchUp?: (session: string | null) => void }) {
  const [mode, setModeState] = useState<VoiceMode>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [target, setTarget] = useState<string>("");
  const ctx = useRef<{ input: HTMLInputElement | HTMLTextAreaElement | null; point: PointTarget | null; cancelled: boolean }>({ input: null, point: null, cancelled: false });
  const mouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const modeRef = useRef<VoiceMode>("idle");
  const pressedAt = useRef(0);
  const setMode = (m: VoiceMode) => { modeRef.current = m; setModeState(m); };
  // The parent passes fresh callbacks on every render. Read them through a ref so the listeners
  // below subscribe once: re-subscribing the async Tauri listener on each render left gaps in which
  // the final text arrived with nobody listening, and nothing was pasted (MR-146).
  const props = useRef({ resolve, send, onFallback, onCatchUp });
  props.current = { resolve, send, onFallback, onCatchUp };

  useEffect(() => {
    const move = (e: MouseEvent) => { mouse.current = { x: e.clientX, y: e.clientY }; };
    const key = (type: "down" | "up") => (e: KeyboardEvent) => {
      const step = voiceKey(modeRef.current, pressedAt.current, { type, code: e.code, key: e.key, alt: e.altKey, repeat: e.repeat, at: performance.now() });
      if (step.swallow) { e.preventDefault(); e.stopPropagation(); }
      if (step.mode !== modeRef.current) setMode(step.mode);
      if (step.act === "start") {
        pressedAt.current = performance.now();
        const a = document.activeElement;
        const input = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? a : null;
        const point = input ? null : pointed(document.elementFromPoint(mouse.current.x, mouse.current.y));
        ctx.current = { input, point, cancelled: false };
        const r = point ? props.current.resolve(point) : null;
        setTarget(input ? "into the focused field" : r ? `to ${r.label}, about ${point!.component}` : "to a new session");
        setText(""); setError("");
        invoke("voice_start").catch((err) => { setError(shortError(err)); setMode("idle"); });
      }
      if (step.act === "stop") void invoke("voice_stop");
      if (step.act === "cancel") { ctx.current.cancelled = true; void invoke("voice_stop"); }
    };
    const down = key("down"), up = key("up");
    // A release outside the window never reaches us: leaving it ends a held talk instead of a stuck mic.
    const blur = () => { if (modeRef.current === "hold") { setMode("stopping"); void invoke("voice_stop"); } };
    window.addEventListener("mousemove", move);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => { window.removeEventListener("blur", blur); window.removeEventListener("mousemove", move); window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); };
  }, []);

  useEffect(() => {
    const un = listen<{ type: string; text?: string; error?: string }>("voice", ({ payload: v }) => {
      if (v.type === "partial") setText(v.text ?? "");
      if (v.type === "error") { setError(shortError(v.error ?? "voice failed")); setMode("idle"); }
      if (v.type === "ended") setMode("idle");
      if (v.type === "final") {
        setMode("idle");
        const said = (v.text ?? "").trim();
        if (!said || ctx.current.cancelled) return;
        const { input, point } = ctx.current;
        const { resolve, send, onFallback, onCatchUp } = props.current;
        // "Catch me up" is a command, not a message (MR-116): a brief of the session pointed at, else the open one.
        if (onCatchUp && /^(please )?catch me up\W*$/i.test(said)) { onCatchUp(point ? resolve(point)?.session ?? null : null); return; }
        if (input) {
          // Type into the field the user was in, keeping React's state in sync.
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
          setter?.call(input, (input.value ? input.value + " " : "") + said);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          return;
        }
        const r = point ? resolve(point) : null;
        if (r && point) send(r.session, `${said}\n\n(I was pointing at ${point.component}: "${point.text.slice(0, 300)}")`);
        else onFallback(said);
      }
    });
    return () => { un.then((f) => f()); };
  }, []);

  // An error hides itself after a few seconds, or on click, so it never sits over the UI.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(t);
  }, [error]);

  if (mode === "idle" && !error) return null;
  const hint = mode === "hands-free" ? `tap ${keyLabel("⌥ Space")} or Enter to send · Esc to cancel`
    : mode === "stopping" ? (ctx.current.cancelled ? "cancelled" : "sending…") : `release ${keyLabel("⌥ Space")} to send · Esc to cancel`;
  return (
    <div role="status" aria-live="polite" data-mr="voice" data-mr-source={mode} style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", minWidth: 420, maxWidth: 760, padding: "12px 16px", background: "var(--mr-ink)", color: "var(--mr-tile)", zIndex: 40, display: "flex", flexDirection: "column", gap: 4, animation: "mr-toast-in .18s ease-out both" }}>
      {error ? <span onClick={() => setError("")} title="Dismiss" style={{ color: "var(--mr-needs)", cursor: "pointer" }}>Voice: {error}</span> : (
        <>
          <span style={{ opacity: 0.7, fontSize: 12 }}>● Listening {target} · {hint}</span>
          <span style={{ fontSize: 16 }}>{text || "…"}</span>
        </>
      )}
    </div>
  );
}
