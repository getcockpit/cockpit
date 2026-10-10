import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ago } from "../picker/now";
import { summarizeTool } from "../picker/toolSummary";
import type { Background, SessionState, TranscriptItem } from "../state/types";
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

// Commands and agents Claude left running in the background (run_in_background). Their transcript
// row scrolls away, so they're pinned here while they run, with their output a click away.
export function BackgroundPanel({ s }: { s: SessionState }) {
  const tasks = backgroundTasks(s);
  const running = tasks.filter((x) => x.live).length;
  const t = useTick(running > 0);
  if (!tasks.length) return null;
  return (
    <section data-mr="BackgroundPanel" data-mr-source={s.id} style={{ background: "var(--mr-tile)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="mr-row" style={{ alignItems: "baseline" }}>
        <h2 className="mr-h mr-grow">Background</h2>
        <span className="mr-mono" style={{ fontSize: 12 }}>{running ? <><b>{running}</b> running</> : "none running"}</span>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {tasks.map((x) => <BgRow key={x.tool.id} x={x} now={t} />)}
      </ol>
    </section>
  );
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
      {open && b.output && <Output path={b.output} live={live} />}
    </li>
  );
}

// The task's output as it's written: the last lines, refreshed every 2 s while it runs.
function Output({ path, live }: { path: string; live: boolean }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => invoke<string>("task_output", { path }).then((o) => alive && setText(o)).catch((e) => alive && setText(`# ${e}`));
    void load();
    if (!live) return () => { alive = false; };
    const i = setInterval(load, 2000);
    return () => { alive = false; clearInterval(i); };
  }, [path, live]);
  const lines = (text ?? "").trimEnd().split("\n").slice(-40).join("\n");
  return (
    <pre className="mr-code mr-reveal" data-mr="BackgroundOutput" data-mr-source={path} style={{ margin: "2px 0 6px 22px", maxHeight: 220, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap" }}>
      {text === null ? "…" : lines || (live ? "No output yet" : "No output")}
    </pre>
  );
}
