import { shortError } from "../components/ErrorLine";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../state/listen";

// Push-to-talk (MR-18) and point + talk (MR-19). Hold ⌥ Space and speak; release to stop.
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

export function VoiceController({ resolve, send, onFallback }: { resolve: Resolve; send: (session: string, text: string) => void; onFallback: (text: string) => void }) {
  const [live, setLive] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [target, setTarget] = useState<string>("");
  const ctx = useRef<{ input: HTMLInputElement | HTMLTextAreaElement | null; point: PointTarget | null }>({ input: null, point: null });
  const mouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    const move = (e: MouseEvent) => { mouse.current = { x: e.clientX, y: e.clientY }; };
    const down = (e: KeyboardEvent) => {
      if (!(e.altKey && e.code === "Space")) return;
      // Swallow every ⌥ Space, auto-repeats included: on macOS each one would type a non-breaking
      // space into the focused field while the user holds the keys to talk.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || live) return;
      const a = document.activeElement;
      const input = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? a : null;
      const point = input ? null : pointed(document.elementFromPoint(mouse.current.x, mouse.current.y));
      ctx.current = { input, point };
      const r = point ? resolve(point) : null;
      setTarget(input ? "into the focused field" : r ? `to ${r.label}, about ${point!.component}` : "to a new session");
      setText(""); setError(""); setLive(true);
      invoke("voice_start").catch((err) => { setError(shortError(err)); setLive(false); });
    };
    const up = (e: KeyboardEvent) => {
      if (!live || (e.code !== "Space" && e.key !== "Alt")) return;
      e.preventDefault();
      void invoke("voice_stop");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); };
  }, [live, resolve]);

  useEffect(() => {
    const un = listen<{ type: string; text?: string; error?: string }>("voice", ({ payload: v }) => {
      if (v.type === "partial") setText(v.text ?? "");
      if (v.type === "error") { setError(shortError(v.error ?? "voice failed")); setLive(false); }
      if (v.type === "ended") setLive(false);
      if (v.type === "final") {
        setLive(false);
        const said = (v.text ?? "").trim();
        if (!said) return;
        const { input, point } = ctx.current;
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
  }, [resolve, send, onFallback]);

  if (!live && !error) return null;
  return (
    <div role="status" aria-live="polite" style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", minWidth: 420, maxWidth: 760, padding: "12px 16px", background: "var(--mr-ink)", color: "var(--mr-tile)", zIndex: 40, display: "flex", flexDirection: "column", gap: 4, animation: "mr-toast-in .18s ease-out both" }}>
      {error ? <span style={{ color: "var(--mr-needs)" }}>Voice: {error}</span> : (
        <>
          <span style={{ opacity: 0.7, fontSize: 12 }}>● Listening {target} · release ⌥ Space to send</span>
          <span style={{ fontSize: 16 }}>{text || "…"}</span>
        </>
      )}
    </div>
  );
}
