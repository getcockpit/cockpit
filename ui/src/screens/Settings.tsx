import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Key } from "../components";
import { api } from "../state/store";
import { sessionTitle } from "../picker/title";
import { isAppChange } from "../picker/queue";
import type { AppState, MrEvent } from "../state/types";

// Settings (decision 25): theme, and the history of your own changes to the app — collected on a
// local branch `mine` that's never pushed — with apply / revert / build & relaunch / roll back.

const THEMES = [
  { id: "control-room", name: "Control Room", what: "Industrial grey, amber when it needs you", swatch: ["#d3d6d9", "#e4e7ea", "#ffb300", "#15181b"] },
  { id: "instrument", name: "Instrument", what: "Braun aluminium, one signal key", swatch: ["#d8d9da", "#eeefef", "#c8d400", "#1a1a1a"] },
  { id: "transit", name: "Transit", what: "Signage white, black bands, signal yellow", swatch: ["#ffffff", "#f0f0f0", "#fccc0a", "#111111"] },
];

type Change = { sha: string; subject: string; at: number; mine_only: boolean };
type Pending = { branch: string; commits: number; subject: string };
type History = { worktree: string; changes: Change[]; pending: Pending[] };
type Build = { id: string; sha: string; branch: string; worktree: string; at: number; current: boolean };

export function Settings({ state, onClose, onOpenSession }: { state: AppState; onClose: () => void; onOpenSession: (id: string) => void }) {
  // Your god-mode reports, newest first, with where each one is (MR-47).
  const [styleAsk, setStyleAsk] = useState("");
  const restyle = async () => {
    if (!styleAsk.trim()) return;
    try {
      const repo = await invoke<string>("app_repo_path");
      const id = await api.start(repo, `Restyle the app: ${styleAsk.trim()}\n\nThis is Minority report's own repo. Change the look only through the design tokens in ui/src/design/tokens.css (colours, fonts, spacing variables; add or adjust a theme block if needed) and, only if a token can't express it, the shared styles in ui/src/design/components.css. Components must keep using var(--mr-*). Keep the signal colours' roles (amber = needs you, red = error, green = done, teal = selected) and light mode only. Run \`cd ui && bun run test && bun run build\`, then commit on this branch as one commit titled "Style: <what changed>". The user applies it to their app from the wall.`, "blank", true);
      setStyleAsk(""); onClose(); onOpenSession(id);
    } catch (e) { setMsg(String(e)); }
  };
  const reports = state.order.map((id) => state.sessions[id]).filter((x) => isAppChange(x)).reverse()
    .map((x) => ({ s: x, state: x.fixApplied ? "Applied" : x.status === "working" || x.status === "starting" ? "Fixing…" : x.status === "error" ? "Fix failed" : "Ready to apply" }));
  const [hist, setHist] = useState<History | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [msg, setMsg] = useState("");
  const [building, setBuilding] = useState<string | null>(null);
  const [clefOn, setClefOn] = useState<boolean | null>(null);
  const [acct, setAcct] = useState("");
  const [token, setToken] = useState("");

  const load = () => {
    invoke<History>("personal_history").then(setHist).catch((e) => setMsg(String(e)));
    invoke<Build[]>("selfbuild_list").then(setBuilds).catch(() => {});
    api.layer2Status().then((r) => setClefOn(r.configured)).catch(() => setClefOn(false));
  };
  useEffect(() => {
    load();
    const un = listen<MrEvent>("mr-event", ({ payload: e }) => {
      if (!e.kind.startsWith("selfbuild.")) return;
      const p = e.payload as Record<string, unknown>;
      if (e.kind === "selfbuild.step") setBuilding(String(p.step));
      if (e.kind === "selfbuild.finished") { setBuilding(null); setMsg(p.ok ? `Built in ${p.seconds}s.` : `Build failed at ${p.step}: ${String(p.log ?? "").slice(-400)}`); load(); }
    });
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => { un.then((f) => f()); window.removeEventListener("keydown", key); };
  }, []);

  const act = async (f: () => Promise<unknown>, done: string) => { setMsg(""); try { await f(); setMsg(done); load(); } catch (e) { setMsg(String(e)); } };
  const buildOf = (sha: string) => builds.find((b) => b.sha.replace("+dirty", "") && sha.startsWith(b.sha.replace("+dirty", "")));

  return (
    <div role="dialog" aria-label="Settings" style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "56px 24px", background: "rgba(21,24,27,.35)", zIndex: 25, overflowY: "auto" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 880, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <div className="mr-row mr-band" style={{ padding: "12px 16px" }}><strong>Settings</strong><span className="mr-grow" /><Key onClick={() => { onClose(); api.report(); }}>Report a bug</Key><Key onClick={() => { void api.log("ui.onboarding_reset", {}); onClose(); }}>Show the intro</Key><Key k="esc" onClick={onClose}>Close</Key></div>

        <section data-mr="Look" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 className="mr-h">Look <span className="mr-dim" style={{ fontWeight: 400 }}>changes apply instantly</span></h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "var(--mr-gap)" }}>
            {THEMES.map((t) => (
              <button key={t.id} type="button" data-mr="ThemeOption" data-mr-source={t.id} onClick={() => void api.log("ui.theme_set", { theme: t.id })}
                style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: 0, outline: state.theme === t.id ? "2px solid var(--mr-selected)" : undefined, outlineOffset: -2, background: "var(--mr-well)", textAlign: "left", font: "inherit", color: "var(--mr-ink)", cursor: "pointer" }}>
                <span style={{ display: "flex", height: 28 }}>{t.swatch.map((c, i) => <i key={i} style={{ flex: 1, background: c }} />)}</span>
                <strong>{t.name}{state.theme === t.id ? " ✓" : ""}</strong>
                <span className="mr-dim">{t.what}</span>
              </button>
            ))}
          </div>
          <div className="mr-row" style={{ gap: 18, flexWrap: "wrap", marginTop: 4 }}>
            <Segmented label="Text size" value={String(state.look.scale)} options={[["0.9", "Smaller"], ["1", "Default"], ["1.12", "Larger"], ["1.25", "Largest"]]} onPick={(v) => void api.log("ui.look_set", { scale: Number(v) })} />
            <Segmented label="Density" value={state.look.density} options={[["compact", "Compact"], ["default", "Default"], ["roomy", "Roomy"]]} onPick={(v) => void api.log("ui.look_set", { density: v })} />
          </div>
          <form className="mr-row" style={{ gap: 8, marginTop: 4 }} onSubmit={(e) => { e.preventDefault(); void restyle(); }}>
            <input className="mr-input" value={styleAsk} onChange={(e) => setStyleAsk(e.target.value)} placeholder="Describe a change to the look, e.g. warmer greys and a bigger wall title" aria-label="Describe a change to the app's look" style={{ flex: 1, background: "var(--mr-well)" }} />
            <Key k="↵" onClick={() => void restyle()} disabled={!styleAsk.trim()}>Restyle</Key>
          </form>
          <span className="mr-dim" style={{ fontSize: 12 }}>Restyle starts a session on the app's own code. When it's done, apply it from the wall like a bug fix; undo it any time under Your changes.</span>
        </section>

        {reports.length > 0 && (
          <section data-mr="Reports" style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
            <h2 className="mr-h">Your reports and restyles <span className="mr-dim" style={{ fontWeight: 400 }}>each runs a session on the app; apply it from the wall or the session</span></h2>
            {reports.map(({ s, state }) => (
              <button key={s.id} type="button" onClick={() => { onClose(); onOpenSession(s.id); }} className="mr-row" style={{ padding: "8px 10px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
                <span style={{ width: 16, color: state === "Applied" ? "var(--mr-done)" : state === "Ready to apply" ? "var(--mr-needs-ink)" : "var(--mr-ink-3)" }}>{state === "Applied" ? "✓" : state === "Ready to apply" ? "◆" : "…"}</span>
                <span className="mr-grow mr-ellipsis">{sessionTitle(s)}</span>
                <span className="mr-dim">{state}</span>
              </button>
            ))}
          </section>
        )}

        <section style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 className="mr-h">Your changes <span className="mr-dim" style={{ fontWeight: 400 }}>on the local branch “mine”, never pushed</span></h2>
          {hist?.pending.map((p) => (
            <div key={p.branch} className="mr-row" style={{ padding: "8px 10px", background: "var(--mr-well)" }}>
              <span style={{ color: "var(--mr-needs-ink)" }}>◆</span>
              <span className="mr-grow"><b>{p.subject}</b> <span className="mr-mono mr-dim">{p.branch} · {p.commits} commit{p.commits === 1 ? "" : "s"}</span></span>
              <Key onClick={() => void act(() => invoke("personal_apply", { branch: p.branch }), `Applied ${p.branch} to your branch.`)}>Apply</Key>
            </div>
          ))}
          <div className="mr-row">
            <Key k="↵" tone="primary" disabled={!hist || !!building} onClick={() => hist && void act(async () => { await invoke("personal_sync"); return invoke("selfbuild_start", { worktree: hist.worktree }); }, "Building your changes on top of the latest app…")}>{building ? `Building · ${building}` : "Build my changes"}</Key>
            <span className="mr-dim mr-mono" style={{ fontSize: 12 }}>{hist?.worktree}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {(hist?.changes ?? []).filter((c) => c.mine_only).length === 0 && <span className="mr-dim">Nothing yet. Fixes and restyles you apply land here, each with Revert.</span>}
            {(hist?.changes ?? []).filter((c) => c.mine_only).map((c) => {
              const b = buildOf(c.sha);
              return (
                <div key={c.sha} className="mr-row" style={{ padding: "8px 4px", borderTop: "1px solid var(--mr-well)" }}>
                  <span className="mr-mono mr-dim" style={{ width: 70 }}>{c.sha.slice(0, 7)}</span>
                  <span className="mr-grow mr-ellipsis">{c.subject}</span>
                  <span className="mr-dim" style={{ fontSize: 12 }}>{new Date(c.at).toLocaleString()}</span>
                  {b && <span className="mr-mono" style={{ fontSize: 12, color: b.current ? "var(--mr-done)" : "var(--mr-ink-3)" }}>{b.current ? "● running" : "built"}</span>}
                  <Key onClick={() => void act(() => invoke("personal_revert", { sha: c.sha }), `Reverted ${c.sha.slice(0, 7)}. Build to use it.`)}>Revert</Key>
                </div>
              );
            })}
          </div>
        </section>

        <section data-mr="ClefSettings" style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 className="mr-h">Picker model <span className="mr-dim" style={{ fontWeight: 400 }}>Cloudflare Clef-flash reads unclear prose; without it the app uses its own rules</span></h2>
          {(() => {
            const m = state.clef.day === new Date().toISOString().slice(0, 10) ? state.clef : { calls: 0, tokens: 0, errors: 0 };
            return (
              <div className="mr-row" style={{ gap: 16 }}>
                <span style={{ color: clefOn ? "var(--mr-done)" : "var(--mr-ink-2)" }}>{clefOn === null ? "…" : clefOn ? "● Connected" : "○ Not connected"}</span>
                <span className="mr-mono">{m.calls} calls today</span>
                <span className="mr-mono">~{m.tokens.toLocaleString()} tokens · ${(m.tokens * 0.09 / 1e6).toFixed(4)}</span>
                {m.errors > 0 && <span style={{ color: "var(--mr-error)" }}>{m.errors} failed, fell back to rules</span>}
                <span className="mr-dim">Free tier: 10,000 neurons a day, resets 00:00 UTC</span>
              </div>
            );
          })()}
          <div className="mr-row" style={{ gap: 8 }}>
            <input aria-label="Cloudflare account ID" placeholder="Account ID" value={acct} onChange={(e) => setAcct(e.target.value)} style={{ flex: 1, font: "inherit", padding: "6px 8px", background: "var(--mr-well)", border: 0, color: "var(--mr-ink)" }} />
            <input aria-label="Cloudflare API token" placeholder="API token (Workers AI: read)" type="password" value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1, font: "inherit", padding: "6px 8px", background: "var(--mr-well)", border: 0, color: "var(--mr-ink)" }} />
            <Key onClick={() => { if (acct.trim() && token.trim()) void act(() => api.layer2Save(acct, token).then(() => { setAcct(""); setToken(""); }), "Saved to the Keychain."); }}>Save</Key>
          </div>
        </section>

        <section style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          <h2 className="mr-h">Builds <span className="mr-dim" style={{ fontWeight: 400 }}>launch any to roll back; a failed launch falls back automatically</span></h2>
          {builds.length === 0 && <span className="mr-dim">None yet.</span>}
          {builds.map((b) => (
            <div key={b.id} className="mr-row" style={{ padding: "6px 4px" }}>
              <span className="mr-mono" style={{ width: 120 }}>{b.sha}</span>
              <span className="mr-grow mr-ellipsis">{b.branch} · <span className="mr-dim">{new Date(b.at).toLocaleString()}</span></span>
              {b.current ? <span style={{ color: "var(--mr-done)" }}>● running</span> : <Key onClick={() => void invoke("selfbuild_relaunch", { buildId: b.id }).catch((e) => setMsg(String(e)))}>Launch</Key>}
            </div>
          ))}
        </section>
        {msg && <div style={{ padding: "0 16px 16px", color: msg.includes("fail") || msg.includes("can't") || msg.includes("conflict") ? "var(--mr-error)" : "var(--mr-ink-2)" }}>{msg}</div>}
      </div>
    </div>
  );
}

function Segmented({ label, value, options, onPick }: { label: string; value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <div className="mr-row" style={{ gap: 8 }}>
      <span className="mr-dim">{label}</span>
      <div role="radiogroup" aria-label={label} className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
        {options.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onPick(v)}
            style={{ border: 0, padding: "5px 12px", font: "inherit", cursor: "pointer", background: value === v ? "var(--mr-ink)" : "transparent", color: value === v ? "var(--mr-tile)" : "var(--mr-ink)" }}>{l}</button>
        ))}
      </div>
    </div>
  );
}
