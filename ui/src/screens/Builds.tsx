import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Key } from "../components";
import type { MrEvent } from "../state/types";

// Self-build (decision 23): rebuild the app from any worktree of its own repo, relaunch into a
// build, or roll back to an earlier one. A failed launch falls back automatically.
type Build = { id: string; sha: string; branch: string; worktree: string; at: number; current: boolean };
type Progress = { id: string; step: string; ok?: boolean; log?: string; seconds?: number };

export function Builds({ defaultWorktree, onClose }: { defaultWorktree?: string; onClose: () => void }) {
  const [builds, setBuilds] = useState<Build[]>([]);
  const [worktree, setWorktree] = useState(defaultWorktree ?? "");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");

  const load = () => invoke<Build[]>("selfbuild_list").then(setBuilds).catch(() => {});
  useEffect(() => {
    load();
    if (!defaultWorktree) invoke<string>("app_repo_path").then(setWorktree).catch((e) => setError(String(e)));
    const un = listen<MrEvent>("mr-event", ({ payload: e }) => {
      if (!e.kind.startsWith("selfbuild.")) return;
      const p = e.payload as Record<string, unknown>;
      if (e.kind === "selfbuild.step") setProgress({ id: String(p.build_id), step: String(p.step) });
      if (e.kind === "selfbuild.finished") { setProgress({ id: String(p.build_id), step: String(p.step ?? "done"), ok: Boolean(p.ok), log: p.log as string, seconds: p.seconds as number }); load(); }
    });
    return () => { un.then((f) => f()); };
  }, [defaultWorktree]);

  const build = async () => { setError(""); try { const id = await invoke<string>("selfbuild_start", { worktree }); setProgress({ id, step: "starting" }); } catch (e) { setError(String(e)); } };
  const relaunch = (id: string) => invoke("selfbuild_relaunch", { buildId: id }).catch((e) => setError(String(e)));
  const running = progress && progress.ok === undefined;

  return (
    <div role="dialog" aria-label="Builds" onKeyDown={(e) => e.key === "Escape" && onClose()}
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "80px 24px", background: "rgba(21,24,27,.35)", zIndex: 20 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 760, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <div className="mr-row mr-band" style={{ padding: "12px 16px" }}><strong>Build the app from inside the app</strong><span className="mr-grow" /><Key k="esc" onClick={onClose}>Close</Key></div>
        <form className="mr-row" style={{ padding: "12px 16px" }} onSubmit={(e) => { e.preventDefault(); void build(); }}>
          <input className="mr-input mr-mono" style={{ fontSize: 13, background: "var(--mr-well)" }} value={worktree} onChange={(e) => setWorktree(e.target.value)} aria-label="Worktree to build" />
          <Key k="↵" tone="primary" disabled={!!running || !worktree}>{running ? "Building…" : "Build"}</Key>
        </form>
        {progress && (
          <div style={{ padding: "0 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="mr-row">
              {["bootstrap", "ui", "app"].map((st) => {
                const order = ["starting", "bootstrap", "ui", "app", "done", "store"];
                const done = progress.ok === true || order.indexOf(progress.step) > order.indexOf(st);
                const failed = progress.ok === false && progress.step === st;
                return <span key={st} className="mr-row" style={{ gap: 6, color: failed ? "var(--mr-error)" : done ? "var(--mr-done)" : progress.step === st ? "var(--mr-ink)" : "var(--mr-ink-3)" }}>{failed ? "✕" : done ? "✓" : progress.step === st ? "▸" : "·"} {st}</span>;
              })}
              <span className="mr-grow" />
              {progress.ok && <Key k="↵" tone="needs" onClick={() => relaunch(progress.id)}>Relaunch into it</Key>}
            </div>
            {progress.ok === false && progress.log && <pre className="mr-code" style={{ maxHeight: 200, overflow: "auto", fontSize: 11 }}>{progress.log}</pre>}
            {progress.ok && <span className="mr-dim">Built in {progress.seconds}s. Relaunching keeps your sessions; if the new build fails to start, the current one comes back automatically.</span>}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", padding: "0 8px 8px" }}>
          <span className="mr-dim" style={{ padding: "4px 8px" }}>Builds</span>
          {builds.length === 0 && <span className="mr-dim" style={{ padding: "4px 8px" }}>None yet.</span>}
          {builds.map((b) => (
            <div key={b.id} className="mr-row" style={{ padding: "8px", background: b.current ? "var(--mr-well)" : "transparent" }}>
              <span className="mr-mono" style={{ width: 120 }}>{b.sha}</span>
              <span className="mr-grow mr-ellipsis">{b.branch} · <span className="mr-dim">{new Date(b.at).toLocaleString()}</span></span>
              {b.current ? <span style={{ color: "var(--mr-done)" }}>● running</span> : <Key onClick={() => relaunch(b.id)}>{"Launch"}</Key>}
            </div>
          ))}
        </div>
        {error && <span style={{ color: "var(--mr-error)", padding: "0 16px 12px" }}>{error}</span>}
      </div>
    </div>
  );
}
