import type { SessionState } from "../state/types";
import { summarizeTool } from "./toolSummary";

// What a working session is doing right now, and how long Claude has been quiet (MR-59: "impossible
// to tell if something is happening"). A running tool reports progress every 30 s, so a minute of
// silence means something is stuck, not just slow.
export const QUIET_MS = 60_000;

export type Now = { label: string; since: number; elapsedMs: number; quietMs: number; stale: boolean };

export function nowLine(s: SessionState, clock = Date.now()): Now | null {
  if (s.status !== "working" && s.status !== "starting") return null;
  const t = Math.max(clock, s.heardAt, s.lastActivity); // an event can land between clock ticks
  // Quiet since Claude last spoke, or since you last wrote to it, whichever is later: a message
  // to a session that sat idle for an hour is not an hour of silence.
  const lastSent = s.transcript.reduce((m, x) => (x.kind === "user" ? Math.max(m, x.at) : m), 0);
  const quietMs = Math.max(0, t - Math.max(s.heardAt, lastSent));
  const at = (label: string, since: number): Now => ({ label, since, elapsedMs: Math.max(0, t - since), quietMs, stale: quietMs >= QUIET_MS });
  if (s.status === "starting") return at("Starting Claude", s.heardAt);
  const last = s.transcript.at(-1);
  if (!last) return at("Starting Claude", s.heardAt);
  if (last.kind === "user") return at(last.delivery === "queued" ? "Finishing its step, then reading your message" : "Reading your message", last.at);
  if (last.kind === "result") return at("Starting on your message", last.at);
  if (last.kind === "tool" && last.result === undefined) return at(summarizeTool(last.name, last.input) || last.name, last.at);
  return at("Thinking", s.heardAt);
}

// "42s", "3m 05s", "1h 02m".
export function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
