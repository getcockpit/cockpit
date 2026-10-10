import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key, ProgressTrack } from "../components";
import { useTick } from "../components/Now";
import { ago } from "../picker/now";
import { shortError } from "../components/ErrorLine";
import { api } from "../state/store";
import type { AppState } from "../state/types";

// One-click Update (decision 27, MR-66): one quiet line under the tabs. It appears when main has
// app changes the running app lacks, builds them in the background while you work, restarts in
// seconds once no session is mid-turn (sessions resume), then says what's new. UI-only changes
// never show here: they're already live.
type Status = { mode: "ready" | "manual" | "unavailable"; pending: { sha: string; subject: string }[] };

const STEP: Record<string, string> = { sidecar: "the sidecar", app: "the app core" };
const list = (xs: string[], n = 3) => (xs.length > n ? `${xs.slice(0, n).join(" · ")} +${xs.length - n} more` : xs.join(" · "));

export function useUpdateStatus(phase: AppState["update"]["phase"]): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    const load = () => invoke<Status>("update_status").then(setStatus).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    return () => { clearInterval(t); window.removeEventListener("focus", load); };
  }, [phase]);
  return status;
}

export const startUpdate = () => invoke("update_start");

export function UpdateBanner({ all, onOpenSession }: { all: AppState; onOpenSession: (id: string) => void }) {
  const u = all.update;
  const status = useUpdateStatus(u.phase);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const t = useTick(u.phase === "building");
  const busy = Object.values(all.sessions).some((s) => !s.archivedAt && (s.status === "working" || s.status === "starting"));

  // Built: restart as soon as no session is mid-turn, so nothing is cut off.
  useEffect(() => {
    if (u.phase !== "ready" || busy) return;
    const k = setTimeout(() => void invoke("update_restart").catch((e) => setError(shortError(e))), 1500);
    return () => clearTimeout(k);
  }, [u.phase, busy]);

  const run = (f: () => Promise<unknown>) => { setError(""); void f().catch((e) => setError(shortError(e))); };
  const fix = async () => {
    const repo = await invoke<string>("app_repo_path");
    const id = await api.start(repo, `Updating the app failed while building ${STEP[u.step ?? ""] ?? u.step}. Find the cause and fix it on a branch, then tell me how to verify. The build output:\n\n${(u.log ?? "").slice(-3000)}`, "blank");
    onOpenSession(id);
  };

  let tone: "needs" | "error" | "done" | null = null;
  let body: React.ReactNode = null;
  if (u.phase === "failed") {
    tone = "error";
    body = <>
      <strong style={{ color: "var(--mr-error)" }}>✕ Update failed while building {STEP[u.step ?? ""] ?? u.step}</strong>
      <span className="mr-dim">your app keeps running as it was</span>
      <span className="mr-grow" />
      <Key onClick={() => setDetails((x) => !x)}>{details ? "Hide details" : "Details"}</Key>
      <Key tone="primary" onClick={() => run(fix)}>Ask Claude to fix</Key>
      <Key onClick={() => void api.log("ui.update_dismissed", {})}>Dismiss</Key>
    </>;
  } else if (u.phase === "building") {
    const segs = u.step === "app" ? (["done", "current"] as const) : (["current", "todo"] as const);
    // mr-grow, not flex: 1: without min-width 0 the commit subjects stretch the line past the window.
    body = <div className="mr-grow" title={u.subjects.join("\n") || undefined}><ProgressTrack segs={[...segs]} fill live source="update"
      left={`Updating · building ${STEP[u.step ?? ""] ?? "…"}${u.subjects.length ? ` · ${list(u.subjects, 2)}` : ""} · keep working`}
      right={u.startedAt ? ago(Math.max(0, t - u.startedAt)) : undefined} /></div>;
  } else if (u.phase === "ready") {
    tone = "done";
    body = busy
      ? <><strong>Update ready</strong><span className="mr-dim">restarts when no session is mid-turn; sessions resume</span><span className="mr-grow" /><Key tone="primary" onClick={() => run(() => invoke("update_restart"))}>Restart now</Key></>
      : <><strong>Update ready</strong><span className="mr-dim">restarting… sessions resume</span></>;
  } else if (u.whatsNew) {
    tone = "done";
    body = <>
      <strong style={{ color: "var(--mr-done)" }}>✓ Updated</strong>
      <span className="mr-ellipsis mr-grow">{u.whatsNew.length ? list(u.whatsNew, 4) : "to the latest main"}</span>
      <Key onClick={() => void api.log("ui.update_seen", {})}>OK</Key>
    </>;
  } else if (status && status.pending.length > 0 && status.mode !== "unavailable") {
    tone = "needs";
    const n = status.pending.length;
    body = <>
      <strong>{n === 1 ? "1 app update" : `${n} app updates`} on main</strong>
      <span className="mr-ellipsis mr-grow mr-ink2">{list(status.pending.map((p) => p.subject))}</span>
      {status.mode === "ready"
        ? <Key k="⌘⇧B" tone="primary" onClick={() => run(startUpdate)}>Update</Key>
        : <span className="mr-dim">start the app with ./scripts/dev.sh to update in one click</span>}
    </>;
  }
  if (!body) return null;
  return (
    <div data-mr="UpdateBanner" data-mr-source={u.phase} style={{ display: "flex", flexDirection: "column", background: "var(--mr-band)", boxShadow: tone ? `inset 4px 0 0 var(--mr-${tone === "needs" ? "needs" : tone === "error" ? "error" : "done"})` : undefined }}>
      <div className="mr-row" style={{ gap: 12, padding: "6px 16px", minHeight: 38 }}>{body}</div>
      {error && <span style={{ color: "var(--mr-error)", padding: "0 16px 6px" }}>{error}</span>}
      {details && u.log && <pre className="mr-code" style={{ margin: "0 16px 8px", maxHeight: 220, overflow: "auto", fontSize: 11 }}>{u.log}</pre>}
    </div>
  );
}
