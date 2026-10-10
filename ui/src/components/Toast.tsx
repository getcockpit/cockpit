import { useEffect, useState } from "react";

// A short acknowledgement at the bottom of the screen (MR-58): "Sent: …". Anything can raise one
// with window.dispatchEvent(new CustomEvent("mr:toast", { detail: "…" })).
export function Toast() {
  const [msg, setMsg] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const on = (e: Event) => { setMsg((m) => ({ text: String((e as CustomEvent).detail), n: (m?.n ?? 0) + 1 })); clearTimeout(t); t = setTimeout(() => setMsg(null), 2200); };
    window.addEventListener("mr:toast", on);
    return () => { window.removeEventListener("mr:toast", on); clearTimeout(t); };
  }, []);
  if (!msg) return null;
  return (
    <div key={msg.n} role="status" aria-live="polite" data-mr="Toast" style={{ position: "fixed", left: "50%", bottom: 56, transform: "translateX(-50%)", zIndex: 70, padding: "8px 14px", background: "var(--mr-ink)", color: "var(--mr-tile)", boxShadow: "0 6px 18px rgba(21,24,27,.25)", maxWidth: "70vw", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", animation: "mr-toast-in .18s ease-out both" }}>
      {msg.text}
    </div>
  );
}

/** "Working on it…" with breathing dots, for while Claude handles what you just sent. */
export function Working({ what }: { what: string }) {
  return <div data-mr="Working" className="mr-working mr-row" style={{ gap: 8, padding: "10px 14px", background: "var(--mr-tile)", color: "var(--mr-ink-2)" }}><span>{what}</span><span><i>●</i><i>●</i><i>●</i></span></div>;
}
