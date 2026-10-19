import { useEffect, useState } from "react";
import { Key, StateMark } from "../components";
import { keyOf } from "../components/keys";
import { FolderPicker } from "../components/FolderPicker";
import { CronBuilder } from "../components/CronBuilder";
import { cadenceExpr, cronLabel } from "../components/cron";
import { PERMISSION_MODES } from "../components/PermissionChoice";
import { pickTile } from "../picker/pick";
import { sessionTitle } from "../picker/title";
import { api } from "../state/store";
import type { AppState, Cadence, PermissionMode, Schedule, ScheduleCheck, ScheduleMode, ScheduleRun, SessionState } from "../state/types";

// Recurring sessions (MR-167): a saved prompt + folder + cadence that Cockpit starts by itself.
// One overlay: the list (next run, pause, Run now), the editor, and each schedule's runs. Every
// change goes through the core, which logs it; the list itself folds from the log (reduce.ts).
// MR-171: a schedule in review mode starts the cmd+k Review for each PR in its repo that needs you.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Weekdays at 09:00", "Mon, Thu at 08:30", "Every 3 h from 09:15", "Every 5 min, 09–17h, Weekdays". */
export function cadenceLabel(c: Cadence): string {
  switch (c.kind) {
    case "cron": return cronLabel(c.expr);
    case "daily": return `Daily at ${c.at}`;
    case "weekdays": return `Weekdays at ${c.at}`;
    case "weekly": return `${(c.days ?? []).map((d) => DAYS[d - 1]).filter(Boolean).join(", ") || "No days"} at ${c.at}`;
    case "hourly": return (c.every_h ?? 1) === 1 ? `Hourly at :${c.at.split(":")[1] ?? "00"}` : `Every ${c.every_h} h from ${c.at}`;
  }
}

/** How a run started and how it went, for the history list. */
export function runLabel(r: ScheduleRun): string {
  const why = r.reason === "manual" ? "run now" : r.reason === "catchup" ? `caught up${r.slot ? ` · due ${new Date(r.slot).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}` : "on time";
  if (!r.ok) return `didn't start${r.url ? ` ${prNum(r.url)}` : ""}: ${r.error ?? "unknown error"}`;
  if (r.mode !== "review") return why;
  const n = r.reviews?.length ?? 0;
  return `${why} · ${n ? `started ${n} review${n === 1 ? "" : "s"} (${r.reviews!.map((x) => (x.number ? `#${x.number}` : prNum(x.url))).join(", ")})` : "nothing new"}`;
}

const prNum = (url: string) => `#${url.split("/").filter(Boolean).pop() ?? "?"}`;

/** A review run that found nothing (MR-171): every 5 minutes these would bury the rest, so runs in a row fold into one row. */
const quiet = (r: ScheduleRun) => r.ok && r.mode === "review" && !(r.reviews?.length);

/** The history, newest first, with runs of "nothing new" in a row folded into one entry that counts them. */
export function historyRows(runs: ScheduleRun[]): { run: ScheduleRun; folded: number; from: number }[] {
  const out: { run: ScheduleRun; folded: number; from: number }[] = [];
  for (const r of [...runs].reverse()) {
    const prev = out[out.length - 1];
    if (prev && quiet(prev.run) && quiet(r)) { prev.folded += 1; prev.from = r.at; continue; }
    out.push({ run: r, folded: 1, from: r.at });
  }
  return out;
}

/** What a schedule's last check said, for its row: "checked 2m ago · skipped 14× (no change)". */
export function checkLabel(c: ScheduleCheck | undefined, now = Date.now(), mode: ScheduleMode = "prompt"): string {
  if (!c) return "not checked yet";
  const ago = Math.max(0, Math.round((now - c.at) / 60_000));
  const why = mode === "review"
    ? { checking: "looking for PRs…", fired: "started reviews", busy: "still looking", no: "nothing new", same: "nothing new", nothing: "nothing new", queued: `${c.waiting ?? 0} waiting for a free session`, error: `couldn't list PRs: ${c.error ?? "unknown error"}` }[c.outcome]
    : { checking: "checking…", fired: "changed: started a run", busy: "last run still going", no: "check said no", same: "no change", nothing: "no change", queued: "waiting for a free session", error: `check failed: ${c.error ?? "unknown error"}` }[c.outcome];
  if (mode === "review") return `checked ${ago ? `${ago}m ago` : "just now"} · ${why}`;
  return `checked ${ago ? `${ago}m ago` : "just now"} · ${why}${c.skipped > 1 ? ` · skipped ${c.skipped}×` : ""}`;
}

/** Ready-made checks: each prints something stable that changes only when there's news. */
export const CHECKS: { label: string; check: string }[] = [
  { label: "Review requests", check: `gh pr list --search "review-requested:@me" --json number,title,updatedAt` },
  { label: "My PRs: reviews + CI", check: `gh pr list --author @me --json number,reviewDecision,statusCheckRollup --jq '.[] | "\(.number) \(.reviewDecision) \([.statusCheckRollup[].conclusion] | unique | join(","))"'` },
  { label: "New commits on main", check: "git fetch -q origin main && git rev-parse origin/main" },
];

/** What a new schedule starts as: from a session ("Repeat…") or blank. */
export type Draft = Partial<Pick<Schedule, "name" | "mode" | "prompt" | "cwd" | "workspace" | "worktree" | "fromSession" | "cadence" | "check">>;

/** The editor's mode choice (MR-171). */
export const MODES: { id: ScheduleMode; label: string }[] = [
  { id: "prompt", label: "Run a prompt" },
  { id: "review", label: "Start a review for each PR that needs me" },
];

/** Starting points on an empty list: picked, they open the editor filled in. */
export const EXAMPLES: { name: string; prompt: string; cadence: Cadence; worktree: boolean; check?: string; mode?: ScheduleMode }[] = [
  { name: "Review each new PR", mode: "review", prompt: "", cadence: { kind: "cron", expr: "*/5 9-17 * * 1-5" }, worktree: false },
  { name: "Review requests watch", prompt: "These pull requests wait on my review (from the check output below). For each one that is new or changed, give one line: what it does and how big the review is. Use gh for detail.", cadence: { kind: "cron", expr: "*/5 9-17 * * 1-5" }, worktree: false, check: CHECKS[0].check },
  { name: "Daily PR digest", prompt: "List the open pull requests in this repo that wait on me or changed since yesterday, one line each on what they need. Use gh.", cadence: { kind: "weekdays", at: "09:00", days: [1], every_h: 1 }, worktree: false },
  { name: "Weekly report", prompt: "Write a short report of what was merged into main in the last 7 days: themes, notable changes, anything risky. Use git log.", cadence: { kind: "weekly", at: "09:00", days: [1], every_h: 1 }, worktree: false },
];

export function draftFrom(s: SessionState): Draft {
  return { name: sessionTitle(s).slice(0, 60), prompt: s.title, cwd: s.repo ?? s.cwd, workspace: s.workspace, worktree: !!s.repo, fromSession: s.id };
}

const when = (t: number) => {
  const d = new Date(t), today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? `today ${time}` : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
};

/** Where this workspace's latest session ran: a likely home for an example schedule. */
const lastFolder = (state: AppState, workspace: string) => {
  const s = state.order.map((id) => state.sessions[id]).filter((x) => x?.workspace === workspace).at(-1);
  return s ? s.repo ?? s.cwd : "";
};

const toast = (detail: string) => window.dispatchEvent(new CustomEvent("mr:toast", { detail }));

export function Recurring({ state, workspace, draft, onClose, onOpenSession }: { state: AppState; workspace: string; draft?: Draft | null; onClose: () => void; onOpenSession: (id: string) => void }) {
  const [editing, setEditing] = useState<Schedule | Draft | null>(draft ?? null);
  const [history, setHistory] = useState<string | null>(null);
  const [next, setNext] = useState<Record<string, number>>({});
  const [checks, setChecks] = useState<Record<string, ScheduleCheck>>({});
  const list = Object.values(state.schedules).sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    let alive = true;
    const load = () => {
      void api.schedulesNext().then((n) => alive && setNext(n ?? {})).catch(() => {});
      void api.schedulesChecks().then((c) => alive && setChecks(c ?? {})).catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [state.schedules]);

  const onKey = (e: React.KeyboardEvent) => { if (keyOf(e) === "Escape") { e.preventDefault(); if (editing) setEditing(null); else onClose(); } };
  const runNow = (sc: Schedule) => void api.scheduleRunNow(sc.id).then((id) => {
    if (!id) return toast(`“${sc.name}”: nothing new to review`); // review mode, every PR already covered
    toast(sc.mode === "review" ? `“${sc.name}” started reviews` : `Started “${sc.name}”`);
    onOpenSession(id);
  }).catch((e) => toast(`Didn't start: ${String(e).split("\n")[0]}`));
  const setPaused = (sc: Schedule, paused: boolean) => void api.scheduleSet({ ...wire(sc), paused }).catch((e) => toast(String(e)));
  const shown = history ? state.schedules[history] : null;

  return (
    <div role="dialog" className="mr-scrim" aria-label="Recurring sessions" data-mr="Recurring" onKeyDown={onKey}
      style={{ position: "fixed", inset: 0, zIndex: 20, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "56px 24px", background: "rgba(21,24,27,.35)", overflowY: "auto" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mr-sheet" style={{ width: "100%", maxWidth: 920, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <div className="mr-band mr-row" style={{ padding: "12px 16px" }}>
          <strong>↻ Recurring sessions</strong><span className="mr-dim">{list.length ? `${list.filter((s) => !s.paused).length} active` : "start a saved prompt on a schedule"}</span>
          <span className="mr-grow" />
          {!editing && <Key tone="primary" onClick={() => setEditing({ workspace, worktree: true })}>New schedule</Key>}
          <Key k="esc" onClick={onClose}>Close</Key>
        </div>
        {editing
          ? <Editor key={"id" in editing ? editing.id : "new"} state={state} initial={editing} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)} />
          : <div style={{ display: "flex", flexDirection: "column", padding: 12, gap: 6 }}>
            {list.length === 0 && <div className="mr-dim" style={{ padding: "8px 4px 12px" }}>No schedules yet. Make one here, or press Repeat… (⌘⇧R) on any session to run it again on a schedule. Runs land on the Wall marked ↻, with a notification when they finish.</div>}
            {list.length === 0 && <section data-mr="RecurringExamples" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <h3 className="mr-h" style={{ padding: "0 4px" }}>Start from an example</h3>
              {EXAMPLES.map((x) => (
                <button key={x.name} type="button" data-mr="RecurringExample" data-mr-source={x.name} className="mr-row" onClick={() => setEditing({ ...x, workspace, cwd: lastFolder(state, workspace) })}
                  style={{ gap: 12, padding: "10px 12px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
                  <strong>{x.name}</strong>
                  <span className="mr-dim mr-grow mr-ellipsis">{x.mode === "review" ? "Starts a review for each PR in the folder's repo that needs you" : x.prompt}</span>
                  <span className="mr-mono mr-dim" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{cadenceLabel(x.cadence)}</span>
                </button>
              ))}
            </section>}
            {list.map((sc) => {
              const last = sc.runs[sc.runs.length - 1];
              return (
                <div key={sc.id} data-mr="ScheduleRow" data-mr-source={sc.id} className="mr-row" style={{ gap: 12, padding: "10px 12px", background: "var(--mr-well)", opacity: sc.paused ? 0.7 : 1 }}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 2 }}>
                    <strong className="mr-ellipsis">↻ {sc.name}</strong>
                    <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }}>{cadenceLabel(sc.cadence)}{sc.mode === "review" ? " · reviews each PR that needs you" : ""} · {sc.cwd}{state.workspaces.length > 1 ? ` · ${state.workspaces.find((w) => w.id === sc.workspace)?.name ?? sc.workspace}` : ""}</span>
                    <span className="mr-dim" style={{ fontSize: 12 }} data-mr="ScheduleNext" data-mr-source={sc.id}>
                      {sc.paused ? "Paused" : next[sc.id] ? `Next ${when(next[sc.id])}` : "Next —"}
                      {last ? ` · last ${when(last.at)} (${runLabel(last)})` : " · never run"}
                    </span>
                    {(sc.check || sc.mode === "review") && <span className="mr-dim mr-ellipsis" style={{ fontSize: 12, color: checks[sc.id]?.outcome === "error" ? "var(--mr-error)" : undefined }} data-mr="ScheduleCheck" data-mr-source={sc.id} title={sc.mode === "review" ? undefined : sc.check ?? undefined}>
                      ⌁ {checkLabel(checks[sc.id], Date.now(), sc.mode)}{sc.mode === "review" ? "" : (() => { const n = sc.runs.filter((r) => r.ok && r.at > Date.now() - 3_600_000).length; return n > 1 ? ` · ${n} runs in the last hour` : ""; })()}
                    </span>}
                  </span>
                  <Key onClick={() => runNow(sc)}>Run now</Key>
                  <Key onClick={() => setPaused(sc, !sc.paused)}>{sc.paused ? "Resume" : "Pause"}</Key>
                  <Key onClick={() => setHistory(history === sc.id ? null : sc.id)}>History{sc.runs.length ? ` (${sc.runs.length})` : ""}</Key>
                  <Key onClick={() => setEditing(sc)}>Edit</Key>
                </div>
              );
            })}
            {shown && <section data-mr="ScheduleHistory" data-mr-source={shown.id} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 4px" }}>
              <h3 className="mr-h">Runs of “{shown.name}”</h3>
              {shown.runs.length === 0 && <span className="mr-dim">None yet.</span>}
              {historyRows(shown.runs).map(({ run: r, folded, from }, i) => {
                const s = r.session ? state.sessions[r.session] : undefined;
                const review = r.mode === "review" && r.ok;
                return (
                  <div key={`${r.at}-${i}`} style={{ display: "flex", flexDirection: "column" }}>
                    <button type="button" className="mr-row" data-mr="ScheduleRun" data-mr-source={r.session ?? shown.id} disabled={!s} onClick={() => s && onOpenSession(s.id)}
                      style={{ gap: 10, padding: "6px 8px", border: 0, background: "transparent", font: "inherit", color: "inherit", textAlign: "left", cursor: s ? "pointer" : "default" }}>
                      <StateMark s={!r.ok ? "error" : s ? pickTile(s).state : "done"} />
                      <span className="mr-mono" style={{ fontSize: 12, minWidth: 150 }}>{folded > 1 ? `${when(from)} – ${new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : when(r.at)}</span>
                      <span className="mr-grow mr-ellipsis">{s ? sessionTitle(s) : review ? (r.reviews?.length ? "" : folded > 1 ? `nothing new, ${folded} runs` : "nothing new") : r.ok ? "(session not on this machine)" : ""}</span>
                      <span className="mr-dim" style={{ fontSize: 12 }}>{runLabel(r)}</span>
                    </button>
                    {review && (r.reviews ?? []).map((pr) => {
                      const rs = state.sessions[pr.session];
                      return (
                        <button key={pr.session} type="button" className="mr-row" data-mr="ScheduleReview" data-mr-source={pr.session} disabled={!rs} onClick={() => rs && onOpenSession(rs.id)}
                          style={{ gap: 10, padding: "4px 8px 4px 34px", border: 0, background: "transparent", font: "inherit", color: "inherit", textAlign: "left", cursor: rs ? "pointer" : "default" }}>
                          <StateMark s={rs ? pickTile(rs).state : "done"} />
                          <span className="mr-mono" style={{ fontSize: 12 }}>{pr.number ? `#${pr.number}` : prNum(pr.url)}</span>
                          <span className="mr-grow mr-ellipsis">{pr.title || pr.url}</span>
                          {!rs && <span className="mr-dim" style={{ fontSize: 12 }}>(session not on this machine)</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </section>}
          </div>}
      </div>
    </div>
  );
}

/** The schedule as the core takes it. */
function wire(sc: Schedule | (Draft & { id?: string; cadence?: Cadence; permissionMode?: PermissionMode; paused?: boolean })) {
  return { id: sc.id, name: sc.name, mode: sc.mode ?? "prompt", prompt: sc.prompt, cwd: sc.cwd, workspace: sc.workspace, worktree: sc.worktree, cadence: sc.cadence, check: sc.check ?? null, permission_mode: sc.permissionMode, paused: sc.paused ?? false, from_session: sc.fromSession ?? null };
}

export function Editor({ state, initial, onCancel, onSaved }: { state: AppState; initial: Schedule | Draft; onCancel: () => void; onSaved: () => void }) {
  const existing = "id" in initial ? (initial as Schedule) : null;
  const [name, setName] = useState(initial.name ?? "");
  const [runMode, setRunMode] = useState<ScheduleMode>(initial.mode ?? "prompt");
  const review = runMode === "review";
  // Review mode works on the folder's GitHub repo: shown as you pick the folder (undefined: looking).
  const [repo, setRepo] = useState<string | null | undefined>(undefined);
  const [prompt, setPrompt] = useState(initial.prompt ?? "");
  const [cwd, setCwd] = useState(initial.cwd ?? "");
  useEffect(() => {
    setRepo(undefined);
    if (!review || !cwd.trim()) return;
    let alive = true;
    void api.ghRepo(cwd).then((r) => alive && setRepo(r ?? null)).catch(() => alive && setRepo(null));
    return () => { alive = false; };
  }, [review, cwd]);
  const [ws, setWs] = useState(initial.workspace ?? "personal");
  const [worktree, setWorktree] = useState(initial.worktree ?? true);
  const [expr, setExpr] = useState(cadenceExpr(existing?.cadence ?? initial.cadence ?? { kind: "cron", expr: "0 9 * * 1-5" }));
  const [check, setCheck] = useState(initial.check ?? "");
  const cadence: Cadence = { kind: "cron", expr };
  const [mode, setMode] = useState<PermissionMode>(existing?.permissionMode ?? "auto");
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = () => {
    setErr(null);
    api.scheduleSet(wire({ id: existing?.id, name, mode: runMode, prompt, cwd, workspace: ws, worktree, cadence, check: check.trim() || null, permissionMode: mode, paused: existing?.paused ?? false, fromSession: initial.fromSession ?? null }))
      .then(() => { toast(existing ? `Saved “${name}”` : `“${name}” is scheduled: ${cadenceLabel(cadence)}`); onSaved(); })
      .catch((e) => setErr(String(e).split("\n")[0]));
  };
  const del = () => existing && void api.scheduleDelete(existing.id).then(() => { toast(`Deleted “${existing.name}”`); onSaved(); });
  const field = { display: "flex", flexDirection: "column" as const, gap: 4 };
  return (
    <form data-mr="ScheduleEditor" data-mr-source={existing?.id ?? "new"} onSubmit={(e) => { e.preventDefault(); save(); }} style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
      <label style={field}><span className="mr-dim">Name</span><input autoFocus className="mr-input" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily PR digest" style={{ background: "var(--mr-well)" }} /></label>
      <div className="mr-row" style={{ gap: 10, flexWrap: "wrap" }} data-mr="ScheduleMode" data-mr-source={existing?.id ?? "new"}>
        <span className="mr-dim">Each run</span>
        <div role="radiogroup" aria-label="Each run" className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={runMode === m.id} onClick={() => setRunMode(m.id)}
              style={{ border: 0, padding: "5px 12px", font: "inherit", cursor: "pointer", background: runMode === m.id ? "var(--mr-ink)" : "transparent", color: runMode === m.id ? "var(--mr-tile)" : "var(--mr-ink)" }}>{m.label}</button>
          ))}
        </div>
      </div>
      {review && <div className="mr-dim" data-mr="ScheduleReviewNote" data-mr-source={existing?.id ?? "new"} style={{ fontSize: 13 }}>
        Each run lists the open PRs in the folder's repo that aren't drafts or yours and that you haven't reviewed, or that have new commits since your review, and starts the same Review as ⌘K for each head not reviewed or started here yet (auto-review's too). Every review stops for you before anything is posted to GitHub.
      </div>}
      {!review && <label style={field}><span className="mr-dim">Prompt <span style={{ fontSize: 12 }}>· each run is a fresh session; ask it to read last time's notes if it should compare</span></span>
        <textarea className="mr-input" aria-label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Summarise the PRs waiting on me, oldest first" style={{ background: "var(--mr-well)", resize: "vertical", font: "inherit" }} /></label>}
      <div style={field}><span className="mr-dim">Folder</span><div className="mr-row">{/* a row: the picker's flex basis is a width */}<FolderPicker value={cwd} onChange={setCwd} extra={Object.values(state.schedules).map((s) => s.cwd)} /></div>
        {review && cwd.trim() && <span data-mr="ScheduleRepo" data-mr-source={existing?.id ?? "new"} className="mr-mono" style={{ fontSize: 12, color: repo === null ? "var(--mr-error)" : undefined }}>
          {repo === undefined ? "Looking up its GitHub repo…" : repo ? `Reviews PRs in ${repo}` : "Not a GitHub repo (no github.com origin): pick the repo's folder"}
        </span>}</div>
      <div className="mr-row" style={{ gap: 16, flexWrap: "wrap" }}>
        {state.workspaces.length > 1 && <label className="mr-row" style={{ gap: 6 }}><span className="mr-dim">Workspace</span>
          <select aria-label="Workspace" value={ws} onChange={(e) => setWs(e.target.value)} className="mr-input" style={{ background: "var(--mr-well)" }}>{state.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
        <label className="mr-row" style={{ gap: 6 }}><input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />{review ? "Own worktree per review (off: /review manages its own, as ⌘K does)" : "Own worktree per run (git repos)"}</label>
      </div>
      <div style={field} data-mr="CadencePicker" data-mr-source={existing?.id ?? "new"}>
        <span className="mr-dim">Runs</span>
        <CronBuilder value={expr} onChange={setExpr} source={existing?.id ?? "new"} />
      </div>
      {!review && <div style={field} data-mr="ScheduleCheckField" data-mr-source={existing?.id ?? "new"}>
        <span className="mr-dim">Only run when… <span style={{ fontSize: 12 }}>· optional: a command run first, for free, in the folder. Claude starts only if it exits 0 and prints something new since the last run; what it prints goes into the prompt. Empty: always run.</span></span>
        <input className="mr-input mr-mono" aria-label="Check command" value={check} onChange={(e) => setCheck(e.target.value)} spellCheck={false} placeholder='gh pr list --search "review-requested:@me" --json number,updatedAt' style={{ background: "var(--mr-well)", fontSize: 13 }} />
        <div className="mr-row" style={{ gap: 4, flexWrap: "wrap" }}>
          {CHECKS.map((c) => <Key key={c.label} onClick={() => setCheck(c.check)}>{c.label}</Key>)}
          <span className="mr-dim" style={{ fontSize: 12 }}>Avoid printing times or durations: they change every run.</span>
        </div>
      </div>}
      {!review && <div className="mr-row" style={{ gap: 10, flexWrap: "wrap" }}>
        <span className="mr-dim">Ask before</span>
        <div role="radiogroup" aria-label="Ask before" className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
          {PERMISSION_MODES.filter((m) => m.id !== "never").map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}
              style={{ border: 0, padding: "5px 12px", font: "inherit", cursor: "pointer", background: mode === m.id ? "var(--mr-ink)" : "transparent", color: mode === m.id ? "var(--mr-tile)" : "var(--mr-ink)" }}>{m.short}</button>
          ))}
        </div>
        <span className="mr-dim" style={{ fontSize: 12 }}>Nobody watches a run: anything it asks waits in Needs you.</span>
      </div>}
      {err && <div role="alert" style={{ color: "var(--mr-error)" }}>{err}</div>}
      <div className="mr-row" style={{ gap: 8 }}>
        {existing && (confirmDelete
          ? <><span style={{ color: "var(--mr-error)" }}>Delete “{existing.name}”? Its past runs stay.</span><Key onClick={del}>Delete</Key><Key onClick={() => setConfirmDelete(false)}>Keep</Key></>
          : <Key onClick={() => setConfirmDelete(true)}>Delete…</Key>)}
        <span className="mr-grow" />
        <Key onClick={onCancel}>Cancel</Key>
        <button type="submit" className="mr-key" data-tone="primary" disabled={!name.trim() || (!review && !prompt.trim()) || !cwd.trim() || (review && repo === null)}>{existing ? "Save" : "Schedule it"}</button>
      </div>
    </form>
  );
}
