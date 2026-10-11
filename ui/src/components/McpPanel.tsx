import { useEffect, useRef, useState } from "react";
import { Key } from ".";
import { shortError } from "./ErrorLine";
import { api } from "../state/store";
import type { McpServer, SessionState } from "../state/types";

// /mcp, in the app (MR-87): the session's MCP servers with their state and tools. Reconnect and
// enable/disable go through Claude Code; signing in needs its own terminal, so that opens one on /mcp.
const LAMP: Record<string, { color: string; label: string }> = {
  connected: { color: "var(--mr-done)", label: "Connected" },
  "needs-auth": { color: "var(--mr-needs)", label: "Needs sign-in" },
  failed: { color: "var(--mr-error)", label: "Failed" },
  pending: { color: "var(--mr-lamp-off)", label: "Connecting" },
  disabled: { color: "var(--mr-lamp-off)", label: "Disabled" },
};
const ORDER = ["needs-auth", "failed", "pending", "connected", "disabled"];

export function McpPanel({ s, onClose, onSignIn }: { s: SessionState; onClose: () => void; onSignIn: () => void }) {
  const live = s.status !== "ended" && s.status !== "error" && s.status !== "interrupted";
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ block: "nearest" }); }, []);
  useEffect(() => { if (live) api.mcpStatus(s.id).catch((e) => setErr(shortError(e))); }, [s.id, live]);
  // Servers still connecting: look again in a few seconds, as /mcp would update in place.
  const connecting = live && !!s.mcp?.servers.some((x) => x.status === "pending");
  useEffect(() => {
    if (!connecting) return;
    const t = setTimeout(() => api.mcpStatus(s.id).catch(() => {}), 3000);
    return () => clearTimeout(t);
  }, [connecting, s.id, s.mcp?.at]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const act = (server: string, action: "reconnect" | "enable" | "disable") => { setErr(""); api.mcpAction(s.id, server, action).catch((e) => setErr(shortError(e))); };

  const servers = [...(s.mcp?.servers ?? [])].filter((x) => x.source !== "sdk").sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  const count = (st: string) => servers.filter((x) => x.status === st).length;
  const done = s.mcp?.done;
  return (
    <section ref={box} data-mr="McpPanel" data-mr-source={s.id} style={{ background: "var(--mr-well)", display: "flex", flexDirection: "column", gap: 2 }}>
      <header className="mr-row" style={{ gap: 10, padding: "10px 12px", background: "var(--mr-band)" }}>
        <strong className="mr-mono">/mcp</strong>
        <span className="mr-dim">{servers.length} servers · {count("connected")} connected{count("needs-auth") ? ` · ${count("needs-auth")} need sign-in` : ""}{count("failed") ? ` · ${count("failed")} failed` : ""}</span>
        <span className="mr-grow" />
        {live && <Key onClick={() => { setErr(""); api.mcpStatus(s.id).catch((e) => setErr(shortError(e))); }}>Refresh</Key>}
        <Key k="esc" onClick={onClose}>Close</Key>
      </header>
      {!live && <div className="mr-dim" style={{ padding: "8px 12px" }}>This session isn't running, so this is the list from when it started. Resume it to reconnect or switch servers.</div>}
      {(err || s.mcp?.error) && <div style={{ padding: "8px 12px", color: "var(--mr-error)" }}>{err || s.mcp?.error}</div>}
      {done && <div style={{ padding: "8px 12px", color: done.ok ? "var(--mr-ink-2)" : "var(--mr-error)" }}>{done.ok ? `✓ ${verb(done.action)} ${done.server}` : `✕ Couldn't ${done.action} ${done.server}: ${done.error ?? "Claude Code refused"}`}</div>}
      {!servers.length && <div className="mr-dim" style={{ padding: "8px 12px" }}>{s.mcp ? "No MCP servers in this session." : "Asking Claude Code…"}</div>}
      {servers.map((x) => <Row key={x.name} x={x} live={live} busy={s.mcp?.busy === x.name} open={open === x.name} onToggle={() => setOpen(open === x.name ? null : x.name)} onAct={(a) => act(x.name, a)} onSignIn={onSignIn} />)}
    </section>
  );
}

const verb = (a: string) => (a === "reconnect" ? "Reconnected" : a === "enable" ? "Enabled" : "Disabled");

function Row({ x, live, busy, open, onToggle, onAct, onSignIn }: { x: McpServer; live: boolean; busy: boolean; open: boolean; onToggle: () => void; onAct: (a: "reconnect" | "enable" | "disable") => void; onSignIn: () => void }) {
  const lamp = LAMP[x.status] ?? { color: "var(--mr-lamp-off)", label: x.status };
  const where = [x.source === "claudeai" ? "claude.ai" : x.source, x.scope && x.scope !== x.source ? x.scope : null, x.version ? `v${x.version}` : null].filter(Boolean).join(" · ");
  return (
    <div data-mr="McpServer" data-mr-source={x.name} style={{ display: "flex", flexDirection: "column", background: "var(--mr-tile)" }}>
      <div className="mr-row" style={{ gap: 10, padding: "8px 12px" }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, flex: "none", background: lamp.color }} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span className="mr-ellipsis"><strong>{x.name}</strong> <span className="mr-dim">{lamp.label}</span></span>
          <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }} title={x.error ?? x.url ?? ""}>{x.error ?? ([where, x.url].filter(Boolean).join(" · ") || " ")}</span>
        </div>
        {x.tools.length > 0 && <Key onClick={onToggle}>{x.tools.length} tools {open ? "▴" : "▾"}</Key>}
        {busy ? <span className="mr-dim">Working…</span> : live && <>
          {x.status === "needs-auth" && <Key tone="needs" onClick={onSignIn}>Sign in…</Key>}
          {(x.status === "failed" || x.status === "connected" || x.status === "needs-auth") && <Key onClick={() => onAct("reconnect")}>Reconnect</Key>}
          {x.status === "disabled" ? <Key onClick={() => onAct("enable")}>Enable</Key> : <Key onClick={() => onAct("disable")}>Disable</Key>}
        </>}
      </div>
      {open && <div className="mr-mono" style={{ padding: "0 12px 10px 32px", fontSize: 12, display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>{x.tools.map((t) => <span key={t}>{t}</span>)}</div>}
    </div>
  );
}
