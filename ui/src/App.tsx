import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type SidecarEvent = { type: string; [k: string]: unknown };
type Link = "starting" | "ready" | "down";

// MR-1 shell: proves UI ⇄ Rust ⇄ sidecar round-trips, in the Control Room look.
export default function App() {
  const [link, setLink] = useState<Link>("starting");
  const [runtime, setRuntime] = useState<string>("");
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [log, setLog] = useState<SidecarEvent[]>([]);

  useEffect(() => {
    const sent = new Map<string, number>();
    (window as unknown as { __mrSent: Map<string, number> }).__mrSent = sent;
    const unlisten = listen<SidecarEvent>("sidecar", ({ payload }) => {
      setLog((l) => [payload, ...l].slice(0, 8));
      if (payload.type === "ready") {
        setLink("ready");
        setRuntime(String(payload.runtime ?? ""));
      }
      if (payload.type === "terminated") setLink("down");
      if (payload.type === "pong" && typeof payload.id === "string" && sent.has(payload.id)) {
        setRttMs(Math.round(performance.now() - sent.get(payload.id)!));
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function ping() {
    const id = crypto.randomUUID();
    (window as unknown as { __mrSent: Map<string, number> }).__mrSent.set(id, performance.now());
    await invoke("sidecar_send", { message: { type: "ping", id } });
  }

  const lit = link === "ready";
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 24px", background: "var(--mr-band)" }}>
        <strong style={{ fontSize: 15 }}>Minority report</strong>
        <span style={{ color: "var(--mr-ink-3)" }}>scaffold</span>
      </header>

      <section aria-label="Status lamps" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "var(--mr-gap)", padding: "12px 24px", background: "var(--mr-band)" }}>
        <Lamp on={link === "down"} tone="error" value={link === "down" ? "1" : "0"} label="Sidecar down" />
        <Lamp on={lit} tone="done" value={lit ? "Up" : "…"} label="Sidecar" />
        <Lamp on={rttMs !== null} tone="plain" value={rttMs === null ? "—" : `${rttMs} ms`} label="Round trip" />
      </section>

      <main style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" onClick={ping} disabled={!lit}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 40, padding: "0 16px", border: 0, borderRadius: "var(--mr-radius)", background: lit ? "var(--mr-ink)" : "var(--mr-lamp-off)", color: "var(--mr-tile)", fontWeight: 700, cursor: lit ? "pointer" : "default" }}>
            <kbd style={{ fontFamily: "var(--mr-mono)", padding: "0 5px", background: "rgba(255,255,255,.15)" }}>P</kbd>
            Ping the sidecar
          </button>
          <span style={{ color: "var(--mr-ink-3)", fontFamily: "var(--mr-mono)" }}>{runtime}</span>
        </div>
        <ol aria-label="Sidecar events" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
          {log.map((e, i) => (
            <li key={i} style={{ padding: "8px 12px", background: "var(--mr-tile)", fontFamily: "var(--mr-mono)", fontSize: 12 }}>{JSON.stringify(e)}</li>
          ))}
        </ol>
      </main>
    </div>
  );
}

function Lamp({ on, tone, value, label }: { on: boolean; tone: "error" | "done" | "plain"; value: string; label: string }) {
  const bg = !on ? "var(--mr-lamp-off)" : tone === "error" ? "var(--mr-error)" : tone === "done" ? "var(--mr-tile)" : "var(--mr-tile)";
  const fg = !on ? "var(--mr-ink-3)" : tone === "error" ? "var(--mr-tile)" : "var(--mr-ink)";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 8px", background: bg, color: fg }}>
      <span style={{ fontFamily: "var(--mr-mono)", fontSize: 22, fontWeight: 700 }}>{value}</span>
      <span style={{ fontWeight: 600 }}>{label}</span>
    </div>
  );
}
