import { useEffect, useState } from "react";
import { Key, StateMark } from "../components";
import { keyOf } from "../components/keys";
import { FolderPicker } from "../components/FolderPicker";
import { PERMISSION_MODES } from "../components/PermissionChoice";
import { pickTile } from "../picker/pick";
import { sessionTitle } from "../picker/title";
import { api } from "../state/store";
import type { AppState, Cadence, PermissionMode, Schedule, ScheduleRun, SessionState } from "../state/types";

// Recurring sessions (MR-167): a saved prompt + folder + cadence that Cockpit starts by itself.
// One overlay: the list (next run, pause, Run now), the editor, and each schedule's runs. Every
// change goes through the core, which logs it; the list itself folds from the log (reduce.ts).

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Weekdays at 09:00", "Mon, Thu at 08:30", "Every 3 h from 09:15". */
export function cadenceLabel(c: Cadence): string {
  switch (c.kind) {
    case "daily": return `Daily at ${c.at}`;
    case "weekdays": return `Weekdays at ${c.at}`;
    case "weekly": return `${(c.days ?? []).map((d) => DAYS[d - 1]).filter(Boolean).join(", ") || "No days"} at ${c.at}`;
    case "hourly": return (c.every_h ?? 1) === 1 ? `Hourly at :${c.at.split(":")[1] ?? "00"}` : `Every ${c.every_h} h from ${c.at}`;
  }
}

/** How a run started and how it went, for the history list. */
export function runLabel(r: ScheduleRun): string {
  const why = r.reason === "manual" ? "run now" : r.reason === "catchup" ? `caught up${r.slot ? ` · due ${new Date(r.slot).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}` : "on time";
  return r.ok ? why : `didn't start: ${r.error ?? "unknown error"}`;
}

/** What a new schedule starts as: from a session ("Repeat…") or blank. */
export type Draft = Partial<Pick<Schedule, "name" | "prompt" | "cwd" | "workspace" | "worktree" | "fromSession">>;

export function draftFrom(s: SessionState): Draft {
  return { name: sessionTitle(s).slice(0, 60), prompt: s.title, cwd: s.repo ?? s.cwd, workspace: s.workspace, worktree: !!s.repo, fromSession: s.id };
}

const when = (t: number) => {
  const d = new Date(t), today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? `today ${time}` : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
};

const toast = (detail: string) => window.dispatchEvent(new CustomEvent("mr:toast", { detail }));

export function Recurring({ state, workspace, draft, onClose, onOpenSession }: { state: AppState; workspace: string; draft?: Draft | null; onClose: () => void; onOpenSession: (id: string) => void }) {
  const [editing, setEditing] = useState<Schedule | Draft | null>(draft ?? null);
  const [history, setHistory] = useState<string | null>(null);
  const [next, setNext] = useState<Record<string, number>>({});
  const list = Object.values(state.schedules).sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    let alive = true;
    const load = () => void api.schedulesNext().then((n) => alive && setNext(n ?? {})).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [state.schedules]);

  const onKey = (e: React.KeyboardEvent) => { if (keyOf(e) === "Escape") { e.preventDefault(); if (editing) setEditing(null); else onClose(); } };
  const runNow = (sc: Schedule) => void api.scheduleRunNow(sc.id).then((id) => { toast(`Started “${sc.name}”`); onOpenSession(id); }).catch((e) => toast(`Didn't start: ${String(e).split("\n")[0]}`));
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
            {list.length === 0 && <div className="mr-dim" style={{ padding: "8px 4px 12px" }}>No schedules yet. Make one here, or press Repeat… on any session to run it again on a schedule. Runs land on the Wall marked ↻, with a notification when they finish.</div>}
            {list.map((sc) => {
              const last = sc.runs[sc.runs.length - 1];
              return (
                <div key={sc.id} data-mr="ScheduleRow" data-mr-source={sc.id} className="mr-row" style={{ gap: 12, padding: "10px 12px", background: "var(--mr-well)", opacity: sc.paused ? 0.7 : 1 }}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 2 }}>
                    <strong className="mr-ellipsis">↻ {sc.name}</strong>
                    <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }}>{cadenceLabel(sc.cadence)} · {sc.cwd}{state.workspaces.length > 1 ? ` · ${state.workspaces.find((w) => w.id === sc.workspace)?.name ?? sc.workspace}` : ""}</span>
                    <span className="mr-dim" style={{ fontSize: 12 }} data-mr="ScheduleNext" data-mr-source={sc.id}>
                      {sc.paused ? "Paused" : next[sc.id] ? `Next ${when(next[sc.id])}` : "Next —"}
                      {last ? ` · last ${when(last.at)} (${runLabel(last)})` : " · never run"}
                    </span>
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
              {[...shown.runs].reverse().map((r, i) => {
                const s = r.session ? state.sessions[r.session] : undefined;
                return (
                  <button key={`${r.at}-${i}`} type="button" className="mr-row" data-mr="ScheduleRun" data-mr-source={r.session ?? shown.id} disabled={!s} onClick={() => s && onOpenSession(s.id)}
                    style={{ gap: 10, padding: "6px 8px", border: 0, background: "transparent", font: "inherit", color: "inherit", textAlign: "left", cursor: s ? "pointer" : "default" }}>
                    <StateMark s={!r.ok ? "error" : s ? pickTile(s).state : "done"} />
                    <span className="mr-mono" style={{ fontSize: 12, minWidth: 150 }}>{when(r.at)}</span>
                    <span className="mr-grow mr-ellipsis">{s ? sessionTitle(s) : r.ok ? "(session not on this machine)" : ""}</span>
                    <span className="mr-dim" style={{ fontSize: 12 }}>{runLabel(r)}</span>
                  </button>
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
  return { id: sc.id, name: sc.name, prompt: sc.prompt, cwd: sc.cwd, workspace: sc.workspace, worktree: sc.worktree, cadence: sc.cadence, permission_mode: sc.permissionMode, paused: sc.paused ?? false, from_session: sc.fromSession ?? null };
}

function Editor({ state, initial, onCancel, onSaved }: { state: AppState; initial: Schedule | Draft; onCancel: () => void; onSaved: () => void }) {
  const existing = "id" in initial ? (initial as Schedule) : null;
  const [name, setName] = useState(initial.name ?? "");
  const [prompt, setPrompt] = useState(initial.prompt ?? "");
  const [cwd, setCwd] = useState(initial.cwd ?? "");
  const [ws, setWs] = useState(initial.workspace ?? "personal");
  const [worktree, setWorktree] = useState(initial.worktree ?? true);
  const [cadence, setCadence] = useState<Cadence>(existing?.cadence ?? { kind: "weekdays", at: "09:00", days: [1], every_h: 1 });
  const [mode, setMode] = useState<PermissionMode>(existing?.permissionMode ?? "auto");
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (c: Partial<Cadence>) => setCadence((x) => ({ ...x, ...c }));
  const save = () => {
    setErr(null);
    api.scheduleSet(wire({ id: existing?.id, name, prompt, cwd, workspace: ws, worktree, cadence, permissionMode: mode, paused: existing?.paused ?? false, fromSession: initial.fromSession ?? null }))
      .then(() => { toast(existing ? `Saved “${name}”` : `“${name}” is scheduled: ${cadenceLabel(cadence)}`); onSaved(); })
      .catch((e) => setErr(String(e).split("\n")[0]));
  };
  const del = () => existing && void api.scheduleDelete(existing.id).then(() => { toast(`Deleted “${existing.name}”`); onSaved(); });
  const field = { display: "flex", flexDirection: "column" as const, gap: 4 };
  return (
    <form data-mr="ScheduleEditor" data-mr-source={existing?.id ?? "new"} onSubmit={(e) => { e.preventDefault(); save(); }} style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
      <label style={field}><span className="mr-dim">Name</span><input autoFocus className="mr-input" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily PR digest" style={{ background: "var(--mr-well)" }} /></label>
      <label style={field}><span className="mr-dim">Prompt <span style={{ fontSize: 12 }}>· each run is a fresh session; ask it to read last time's notes if it should compare</span></span>
        <textarea className="mr-input" aria-label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Summarise the PRs waiting on me, oldest first" style={{ background: "var(--mr-well)", resize: "vertical", font: "inherit" }} /></label>
      <div style={field}><span className="mr-dim">Folder</span><div className="mr-row">{/* a row: the picker's flex basis is a width */}<FolderPicker value={cwd} onChange={setCwd} extra={Object.values(state.schedules).map((s) => s.cwd)} /></div></div>
      <div className="mr-row" style={{ gap: 16, flexWrap: "wrap" }}>
        {state.workspaces.length > 1 && <label className="mr-row" style={{ gap: 6 }}><span className="mr-dim">Workspace</span>
          <select aria-label="Workspace" value={ws} onChange={(e) => setWs(e.target.value)} className="mr-input" style={{ background: "var(--mr-well)" }}>{state.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
        <label className="mr-row" style={{ gap: 6 }}><input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />Own worktree per run (git repos)</label>
      </div>
      <div className="mr-row" style={{ gap: 10, flexWrap: "wrap" }} data-mr="CadencePicker" data-mr-source={existing?.id ?? "new"}>
        <span className="mr-dim">Runs</span>
        <div role="radiogroup" aria-label="Cadence" className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
          {([["daily", "Daily"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["hourly", "Every N hours"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={cadence.kind === k} onClick={() => set({ kind: k })}
              style={{ border: 0, padding: "5px 12px", font: "inherit", cursor: "pointer", background: cadence.kind === k ? "var(--mr-ink)" : "transparent", color: cadence.kind === k ? "var(--mr-tile)" : "var(--mr-ink)" }}>{l}</button>
          ))}
        </div>
        {cadence.kind === "weekly" && <div className="mr-row" style={{ gap: 2 }} role="group" aria-label="Days">
          {DAYS.map((d, i) => { const on = (cadence.days ?? []).includes(i + 1); return (
            <button key={d} type="button" aria-pressed={on} onClick={() => set({ days: on ? (cadence.days ?? []).filter((x) => x !== i + 1) : [...(cadence.days ?? []), i + 1].sort() })}
              style={{ border: 0, padding: "5px 8px", font: "inherit", cursor: "pointer", background: on ? "var(--mr-selected)" : "var(--mr-well)", color: on ? "var(--mr-tile)" : "var(--mr-ink)" }}>{d}</button>
          ); })}
        </div>}
        {cadence.kind === "hourly" && <label className="mr-row" style={{ gap: 6 }}>every<input type="number" min={1} max={24} aria-label="Every N hours" value={cadence.every_h ?? 1} onChange={(e) => set({ every_h: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })} className="mr-input" style={{ width: 64, background: "var(--mr-well)" }} />h from</label>}
        {cadence.kind !== "hourly" && <span className="mr-dim">at</span>}
        <input type="time" aria-label="Time" value={cadence.at} onChange={(e) => set({ at: e.target.value || "09:00" })} className="mr-input" style={{ background: "var(--mr-well)" }} />
        <span className="mr-dim" style={{ fontSize: 12 }}>{cadenceLabel(cadence)}, your local time</span>
      </div>
      <div className="mr-row" style={{ gap: 10, flexWrap: "wrap" }}>
        <span className="mr-dim">Ask before</span>
        <div role="radiogroup" aria-label="Ask before" className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
          {PERMISSION_MODES.filter((m) => m.id !== "never").map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}
              style={{ border: 0, padding: "5px 12px", font: "inherit", cursor: "pointer", background: mode === m.id ? "var(--mr-ink)" : "transparent", color: mode === m.id ? "var(--mr-tile)" : "var(--mr-ink)" }}>{m.short}</button>
          ))}
        </div>
        <span className="mr-dim" style={{ fontSize: 12 }}>Nobody watches a run: anything it asks waits in Needs you.</span>
      </div>
      {err && <div role="alert" style={{ color: "var(--mr-error)" }}>{err}</div>}
      <div className="mr-row" style={{ gap: 8 }}>
        {existing && (confirmDelete
          ? <><span style={{ color: "var(--mr-error)" }}>Delete “{existing.name}”? Its past runs stay.</span><Key onClick={del}>Delete</Key><Key onClick={() => setConfirmDelete(false)}>Keep</Key></>
          : <Key onClick={() => setConfirmDelete(true)}>Delete…</Key>)}
        <span className="mr-grow" />
        <Key onClick={onCancel}>Cancel</Key>
        <button type="submit" className="mr-key" data-tone="primary" disabled={!name.trim() || !prompt.trim() || !cwd.trim()}>{existing ? "Save" : "Schedule it"}</button>
      </div>
    </form>
  );
}
