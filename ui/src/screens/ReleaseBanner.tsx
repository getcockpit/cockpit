import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key } from "../components";
import { shortError } from "../components/ErrorLine";
import { api } from "../state/store";

// Updates from GitHub releases (MR-136), on the Update banner's line. A release build swaps in the
// signed release and restarts. A self-built app merges the release into your changes (`mine`) and
// rebuilds; when that doesn't fit, nothing changes and you choose: a plan from Claude, keep your
// build, or take the release with your changes set aside.
export type ReleaseStatus = {
  mode: "swap" | "merge" | "off";
  phase: "idle" | "available" | "ready" | "conflicts" | "installing" | "building" | "failed";
  version: string;
  notes: string;
  preview: { yours: number; brings: number; conflicts: string[] } | null;
  failure: { stage: string; log: string } | null;
  updated: string | null;
};

export type Choice = "install" | "plan" | "keep" | "take" | "retry" | "details" | "seen";

const STAGE: Record<string, string> = {
  fetch: "couldn't fetch it into your repo",
  download: "the download failed",
  merge: "merging it into your changes failed",
  build: "your build with it failed",
  health: "the merged build didn't start, so your previous build is back",
};
const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

/** What the line says and offers, from the status alone. */
export function releaseView(s: ReleaseStatus): { tone: "needs" | "error" | "done" | null; title: string; detail: string; actions: { choice: Choice; label: string; primary?: boolean }[] } | null {
  const v = `Cockpit ${s.version}`;
  const clash = [{ choice: "plan" as const, label: "Ask Claude for a plan", primary: true }, { choice: "keep" as const, label: "Keep my build" }, { choice: "take" as const, label: "Take the release, set my changes aside" }];
  if (s.phase === "available") return { tone: "needs", title: `${v} is out`, detail: s.notes, actions: [{ choice: "install", label: "Restart to update", primary: true }] };
  if (s.phase === "ready" && s.preview) return { tone: "needs", title: `${v} is out`, detail: `merges cleanly with your ${n(s.preview.yours, "change")}`, actions: [{ choice: "install", label: "Merge into my build", primary: true }, { choice: "keep", label: "Not now" }] };
  if (s.phase === "conflicts" && s.preview) return { tone: "needs", title: `${v} is out`, detail: `${n(s.preview.conflicts.length, "file")} clash with your changes: ${s.preview.conflicts.slice(0, 3).join(", ")}${s.preview.conflicts.length > 3 ? "…" : ""} · nothing changed`, actions: [...clash, { choice: "details", label: "Details" }] };
  if (s.phase === "installing") return { tone: null, title: `Updating to ${v}`, detail: "downloading… the app restarts when it's in; sessions resume", actions: [] };
  if (s.phase === "building") return { tone: null, title: `Building your app with ${v}`, detail: "keep working; it relaunches when the build passes, sessions resume", actions: [] };
  if (s.phase === "failed") {
    const stage = s.failure?.stage ?? "";
    const actions = stage === "fetch" || stage === "download" ? [{ choice: "retry" as const, label: "Retry", primary: true }, { choice: "keep" as const, label: "Skip this version" }] : clash;
    return { tone: "error", title: `${v}: ${STAGE[stage] ?? "the update failed"}`, detail: "your app keeps running as it was", actions: [...actions, { choice: "details", label: "Details" }] };
  }
  if (s.updated) return { tone: "done", title: `✓ Updated to Cockpit ${s.updated}`, detail: "", actions: [{ choice: "seen", label: "OK" }] };
  return null;
}

export function ReleaseBanner({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [s, setS] = useState<ReleaseStatus | null>(null);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const load = () => invoke<ReleaseStatus>("release_status").then(setS).catch(() => {});
  useEffect(() => {
    void load();
    const busy = s?.phase === "installing" || s?.phase === "building";
    const t = setInterval(load, busy ? 3_000 : 60_000);
    window.addEventListener("focus", load);
    return () => { clearInterval(t); window.removeEventListener("focus", load); };
  }, [s?.phase]);
  if (!s) return null;
  const view = releaseView(s);
  if (!view) return null;

  const act = async (c: Choice) => {
    setError("");
    try {
      if (c === "details") return setDetails((x) => !x);
      if (c === "install") await invoke("release_install");
      else if (c === "retry") await invoke("release_check");
      else if (c === "seen") await invoke("release_seen");
      else {
        const r = await invoke<{ cwd?: string; prompt?: string } | null>("release_choose", { choice: c });
        if (c === "plan" && r?.cwd && r.prompt) onOpenSession(await api.start(r.cwd, r.prompt, "blank"));
      }
    } catch (e) { setError(shortError(e)); }
    void load();
  };
  const log = s.failure?.log || (s.preview?.conflicts.length ? `Conflicting files:\n${s.preview.conflicts.join("\n")}` : "");
  return (
    <div data-mr="ReleaseBanner" data-mr-source={`${s.phase}:${s.version}`} style={{ display: "flex", flexDirection: "column", background: "var(--mr-band)", boxShadow: view.tone ? `inset 4px 0 0 var(--mr-${view.tone})` : undefined }}>
      <div className="mr-row" style={{ gap: 12, padding: "6px 16px", minHeight: 38 }}>
        <strong style={{ whiteSpace: "nowrap", ...(view.tone === "error" ? { color: "var(--mr-error)" } : view.tone === "done" ? { color: "var(--mr-done)" } : {}) }}>{view.title}</strong>
        <span className="mr-ellipsis mr-grow mr-ink2" title={s.notes || undefined}>{view.detail}</span>
        {view.actions.map((a) => <Key key={a.choice} tone={a.primary ? "primary" : undefined} pressed={a.choice === "details" && details} onClick={() => void act(a.choice)}>{a.choice === "details" && details ? "Hide details" : a.label}</Key>)}
      </div>
      {error && <span style={{ color: "var(--mr-error)", padding: "0 16px 6px" }}>{error}</span>}
      {details && log && <pre className="mr-code" style={{ margin: "0 16px 8px", maxHeight: 220, overflow: "auto", fontSize: 11 }}>{log}</pre>}
    </div>
  );
}
