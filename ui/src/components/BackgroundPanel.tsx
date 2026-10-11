import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ago } from "../picker/now";
import { summarizeTool } from "../picker/toolSummary";
import type { Background, Run, SessionState, TranscriptItem } from "../state/types";
import { api } from "../state/store";
import { Mark } from "./Turn";
import { useTick } from "./Now";

type Tool = Extract<TranscriptItem, { kind: "tool" }>;
export type BgTask = { tool: Tool; b: Background; live: boolean };

// The session's background tasks, running first. One still marked running in a session that has
// ended can't be running any more: Claude Code stops its tasks with it.
export function backgroundTasks(s: SessionState): BgTask[] {
  const alive = s.status !== "ended" && s.status !== "error" && s.status !== "interrupted";
  return s.transcript
    .filter((t): t is Tool & { background: Background } => t.kind === "tool" && !!t.background)
    .map((tool) => ({ tool, b: tool.background, live: alive && tool.background.status === "running" }))
    .sort((a, b) => Number(b.live) - Number(a.live) || (b.b.from ?? b.tool.at) - (a.b.from ?? a.tool.at));
}

// What this session set running: commands and agents Claude left in the background
// (run_in_background), and commands you ran from a reply's Run button (MR-85). Their transcript
// rows scroll away, so they're pinned here while they run, with their output a click away.
export function BackgroundPanel({ s }: { s: SessionState }) {
  const tasks = backgroundTasks(s);
  const runs = [...s.runs].reverse().sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
  const running = tasks.filter((x) => x.live).length + runs.filter((r) => r.status === "running").length;
  const t = useTick(running > 0);
  if (!tasks.length && !runs.length) return null;
  return (
    <section data-mr="BackgroundPanel" data-mr-source={s.id} style={{ background: "var(--mr-tile)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="mr-row" style={{ alignItems: "baseline" }}>
        <h2 className="mr-h mr-grow">Running</h2>
        <span className="mr-mono" style={{ fontSize: 12 }}>{running ? <><b>{running}</b> running</> : "none running"}</span>
      </div>
      {runs.length > 0 && (
        <ol aria-label="Your runs" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {runs.map((r) => <RunRow key={r.id} s={s} r={r} now={t} />)}
        </ol>
      )}
      {tasks.length > 0 && (
        <ol aria-label="Claude's background tasks" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {tasks.map((x) => <BgRow key={x.tool.id} x={x} now={t} />)}
        </ol>
      )}
    </section>
  );
}

// A command you ran: who started it, how it's going, its output, Stop while it runs, and its
// output handed to Claude in one click once it's done.
function RunRow({ s, r, now }: { s: SessionState; r: Run; now: number }) {
  const live = r.status === "running";
  const [open, setOpen] = useState(live);
  const failed = r.status === "failed" || r.status === "lost";
  const took = live ? Math.max(0, now - r.from) : r.to ? r.to - r.from : null;
  return (
    <li data-mr="RunTask" data-mr-source={r.id} data-state={r.status} style={{ display: "flex", flexDirection: "column" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="mr-row" title={`${r.command}\nin ${r.cwd}`}
        style={{ alignItems: "baseline", gap: 8, padding: "4px 0", border: 0, background: "transparent", color: live ? "var(--mr-ink)" : "var(--mr-ink-2)", font: "inherit", textAlign: "left", cursor: "pointer", fontWeight: live ? 700 : 400 }}>
        <span style={{ flex: "none", width: 14, display: "inline-flex", justifyContent: "center" }}>
          {live ? <span className="mr-now-step" aria-label="Running">▸</span> : failed ? <span style={{ color: "var(--mr-error)" }} aria-label={r.status}>✕</span> : r.status === "stopped" ? <span className="mr-dim" aria-label="Stopped">■</span> : <Mark tone="done" />}
        </span>
        <span className="mr-mono mr-dim" style={{ flex: "none", fontSize: 11, fontWeight: 400 }}>you</span>
        <span className="mr-grow mr-ellipsis mr-mono" style={{ fontSize: 12 }}>{r.command.split("\n")[0]}</span>
        <span className="mr-mono" style={{ fontSize: 11, fontWeight: 400, whiteSpace: "nowrap", color: failed ? "var(--mr-error)" : undefined }}>
          {live ? ago(took ?? 0) : r.status === "failed" ? `exit ${r.code ?? "?"}` : r.status === "lost" ? "lost on restart" : r.status === "stopped" ? "stopped" : took !== null ? ago(took) : "done"}
        </span>
        <span className="mr-mono" style={{ fontSize: 12, fontWeight: 400 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <>
          <Output read={() => invoke<string>("run_output", { runId: r.id })} source={r.id} live={live} />
          <span className="mr-row" style={{ gap: 6, margin: "0 0 6px 22px" }}>
            {live
              ? <button type="button" className="mr-key" data-mr="RunStop" data-mr-source={r.id} style={{ minHeight: 26, padding: "0 10px", fontSize: 12 }} onClick={() => void api.runStop(s.id, r.id)}>■ Stop</button>
              : <button type="button" className="mr-key" data-mr="RunToClaude" data-mr-source={r.id} style={{ minHeight: 26, padding: "0 10px", fontSize: 12 }} onClick={() => void sendToClaude(s, r)}>Send output to Claude</button>}
          </span>
        </>
      )}
    </li>
  );
}

// Hands a finished run to Claude: the command, how it ended and the end of its output.
async function sendToClaude(s: SessionState, r: Run) {
  const out = (await invoke<string>("run_output", { runId: r.id }).catch(() => "")).trimEnd().split("\n").slice(-60).join("\n");
  const ended = r.status === "completed" ? "it finished OK" : r.status === "failed" ? `it failed with exit ${r.code ?? "?"}` : `it was ${r.status}`;
  await api.send(s.id, `I ran \`${r.command}\` and ${ended}. The end of its output:\n\`\`\`\n${out || "(no output)"}\n\`\`\``);
}

function BgRow({ x, now }: { x: BgTask; now: number }) {
  const [open, setOpen] = useState(x.live);
  const { tool, b, live } = x;
  const failed = !live && b.status !== "completed" && b.status !== "running";
  const from = b.from ?? tool.at;
  const took = live ? Math.max(0, now - from) : b.to ? b.to - from : null;
  const what = String(tool.input.description ?? "") || summarizeTool(tool.name, tool.input);
  return (
    <li data-mr="BackgroundTask" data-mr-source={tool.toolUseId} data-state={live ? "running" : b.status} style={{ display: "flex", flexDirection: "column" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={!b.output} className="mr-row" title={b.summary ?? String(tool.input.command ?? "")}
        style={{ alignItems: "baseline", gap: 8, padding: "4px 0", border: 0, background: "transparent", color: live ? "var(--mr-ink)" : "var(--mr-ink-2)", font: "inherit", textAlign: "left", cursor: b.output ? "pointer" : "default", fontWeight: live ? 700 : 400 }}>
        <span style={{ flex: "none", width: 14, display: "inline-flex", justifyContent: "center" }}>
          {live ? <span className="mr-now-step" aria-label="Running">▸</span> : failed ? <span style={{ color: "var(--mr-error)" }} aria-label={b.status}>✕</span> : b.status === "running" ? <span className="mr-dim" aria-label="Stopped with the session">·</span> : <Mark tone="done" />}
        </span>
        <span className="mr-grow mr-ellipsis">{what}</span>
        <span className="mr-mono" style={{ fontSize: 11, fontWeight: 400, whiteSpace: "nowrap", color: failed ? "var(--mr-error)" : undefined }}>
          {live ? ago(took ?? 0) : failed ? b.status : b.status === "running" ? "stopped" : took !== null ? ago(took) : "done"}
        </span>
        {b.output && <span className="mr-mono" style={{ fontSize: 12, fontWeight: 400 }}>{open ? "▾" : "▸"}</span>}
      </button>
      {open && b.output && <Output read={() => invoke<string>("task_output", { path: b.output })} source={b.output} live={live} />}
    </li>
  );
}

// The task's output as it's written: the last lines, refreshed every 2 s while it runs.
function Output({ read, source, live }: { read: () => Promise<string>; source: string; live: boolean }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => read().then((o) => alive && setText(o)).catch((e) => alive && setText(`# ${e}`));
    void load();
    if (!live) return () => { alive = false; };
    const i = setInterval(load, 2000);
    return () => { alive = false; clearInterval(i); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is rebuilt each render; `source` names what it reads
  }, [source, live]);
  const lines = (text ?? "").trimEnd().split("\n").slice(-40).join("\n");
  return (
    <pre className="mr-code mr-reveal" data-mr="BackgroundOutput" data-mr-source={source} style={{ margin: "2px 0 6px 22px", maxHeight: 220, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap" }}>
      {text === null ? "…" : lines || (live ? "No output yet" : "No output")}
    </pre>
  );
}
