// Task log cards (MR-75): the transcript's tool calls drawn as catalog components, straight from
// the events (decision 26, no model). File edits become Snippet cards; test, build and type-check
// runs become Verification checklist rows.

import type { TranscriptItem } from "../state/types";
import { summarizeTool } from "./toolSummary";

type Tool = Extract<TranscriptItem, { kind: "tool" }>;
type Hunk = { oldStart?: number; newStart?: number; lines?: string[] };

export type EditCard = { file: string; path: string; where: string; code: string; added: number; removed: number; more: number };
export type CheckRow = { label: string; ok: boolean | null; proof: string };

const MAX_LINES = 40;
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const prefixed = (s: string, c: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n").map((l) => c + l));

// An Edit, MultiEdit or Write, as the changed lines. Prefers the patch Claude Code returns (it
// carries line numbers and context); falls back to the tool input while the call is in flight.
export function editCard(t: Tool): EditCard | null {
  if (!["Edit", "MultiEdit", "Write"].includes(t.name) || t.isError) return null;
  const path = String(t.input.file_path ?? "");
  if (!path) return null;
  const r = rec(t.result);
  const hunks = Array.isArray(r.structuredPatch) ? (r.structuredPatch as Hunk[]) : [];
  let lines: string[];
  let where = "";
  if (hunks.length) {
    lines = hunks.flatMap((h, i) => [...(i > 0 ? ["⋯"] : []), ...(h.lines ?? [])]);
    const starts = hunks.map((h) => h.newStart).filter((n): n is number => typeof n === "number");
    if (starts.length) where = starts.length === 1 ? `line ${starts[0]}` : `lines ${starts.join(", ")}`;
  } else if (t.name === "Write") {
    lines = prefixed(String(t.input.content ?? ""), "+");
    where = "new file";
  } else {
    const edits = t.name === "MultiEdit" && Array.isArray(t.input.edits) ? (t.input.edits as Record<string, unknown>[]) : [t.input];
    lines = edits.flatMap((e, i) => [...(i > 0 ? ["⋯"] : []), ...prefixed(String(e.old_string ?? ""), "-"), ...prefixed(String(e.new_string ?? ""), "+")]);
  }
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  return { file: base(path), path, where, code: lines.slice(0, MAX_LINES).join("\n"), added, removed, more: Math.max(0, lines.length - MAX_LINES) };
}

// Commands that prove something: tests, builds, type-checks, lints.
const CHECK = /\b(vitest|jest|pytest|go test|cargo (test|build|check|clippy)|(bun|npm|pnpm|yarn)( run)? (test|build|typecheck|lint)|bun test|tsc\b|selftest[\w-]*\.sh)/;

export function isCheck(t: Tool): boolean {
  return t.name === "Bash" && CHECK.test(String(t.input.command ?? ""));
}

const out = (result: unknown) => {
  if (typeof result === "string") return result;
  const r = rec(result);
  if (Array.isArray(r.content)) return r.content.map((c) => String(rec(c).text ?? "")).join("\n");
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
};
const sum = (text: string, re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);

// The counts a runner prints, summed across runners in one command: "77 passed · 1 failed".
export function counts(text: string): { passed: number; failed: number; errors: number } {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  // vitest/jest "Tests  1 failed | 76 passed (77)", cargo "test result: ok. 42 passed; 0 failed",
  // bun "12 pass" / "0 fail", pytest "3 passed, 1 failed".
  const tests = clean.split("\n").filter((l) => /^\s*Tests\b|test result:|^\s*\d+ (pass|fail)\b|=+ .*(passed|failed)/.test(l)).join("\n");
  const passed = sum(tests, /(\d+) pass(?:ed)?\b/g);
  const failed = sum(tests, /(\d+) fail(?:ed)?\b/g);
  // tsc: "Found 3 errors" or one "error TS…" per line; cargo/rustc "error[E…]" / "error: could not compile".
  const found = clean.match(/Found (\d+) errors?/);
  const errors = found ? Number(found[1]) : (clean.match(/error TS\d+|^error(\[E\d+\])?:/gm) ?? []).length;
  return { passed, failed, errors };
}

export function checkRow(t: Tool): CheckRow {
  const label = summarizeTool(t.name, t.input);
  if (t.result === undefined) return { label, ok: null, proof: "running" };
  const text = out(t.result);
  const c = counts(text);
  const ok = !t.isError && c.failed === 0 && c.errors === 0;
  const proof = [c.passed && `${c.passed} passed`, c.failed && `${c.failed} failed`, c.errors && `${c.errors} ${c.errors === 1 ? "error" : "errors"}`].filter(Boolean).join(" · ");
  if (proof) return { label, ok, proof };
  // No counts: the first error-looking line when it failed, else just that it ran clean.
  const firstErr = text.split("\n").map((l) => l.trim()).find((l) => /error|fail|panic/i.test(l));
  return { label, ok, proof: ok ? "exit 0" : (firstErr ?? "failed").slice(0, 120) };
}

// Tool calls the log draws as a card instead of folding into a step's actions.
export function isCard(t: TranscriptItem): t is Tool {
  return t.kind === "tool" && (isCheck(t) || editCard(t) !== null);
}

// A plan step at a glance (MR-76): its actions as Tally bar segments and the files it touched as
// Change graph chips. Reads and searches are the quiet part; failures are red.
export type StepTally = { n: number; label: string; tone: "done" | "now" | "deferred" | "todo" | "error" };
export type TouchedFile = { label: string; path: string; mark: "+" | "~"; added: number; removed: number };

const LOOK = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "LS", "NotebookRead"]);

export function stepSummary(tools: Tool[]): { tally: StepTally[]; files: TouchedFile[] } {
  let edits = 0, passed = 0, failed = 0, commands = 0, looked = 0;
  const files = new Map<string, TouchedFile>();
  for (const t of tools) {
    if (t.isError) { failed++; continue; }
    const c = editCard(t);
    if (c) {
      edits++;
      const f = files.get(c.path) ?? { label: c.file, path: c.path, mark: c.where === "new file" || rec(t.result).type === "create" ? "+" : "~", added: 0, removed: 0 };
      f.added += c.added;
      f.removed += c.removed;
      files.set(c.path, f);
    } else if (isCheck(t)) {
      const ok = checkRow(t).ok;
      if (ok === false) failed++;
      else if (ok) passed++; // still running: the step header says "now: …"
    } else if (t.name === "Bash") commands++;
    else if (LOOK.has(t.name)) looked++;
  }
  const tally: StepTally[] = [
    { n: edits, label: edits === 1 ? "edit" : "edits", tone: "now" },
    { n: passed, label: passed === 1 ? "check passed" : "checks passed", tone: "done" },
    { n: failed, label: "failed", tone: "error" },
    { n: commands, label: commands === 1 ? "command" : "commands", tone: "todo" },
    { n: looked, label: looked === 1 ? "read or search" : "reads and searches", tone: "deferred" },
  ];
  return { tally: tally.filter((x) => x.n > 0), files: [...files.values()] };
}
