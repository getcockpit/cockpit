import { invoke } from "@tauri-apps/api/core";
import type { PendingAsk } from "../state/types";

// What the phone may ask the Mac to do: the `remote_link::proto::Command` allowlist, as `{kind, args}`.
// The decisions match the desktop's (`screens/AskRow.tsx`), so the Mac can't tell them apart except
// by `origin: "remote"`. The mobile core asks for Face ID before allow / answer / start leave the phone.
export type Command =
  | { kind: "send_prompt"; args: { session: string; text: string } }
  | { kind: "permission_response"; args: { session: string; request_id: string; decision: Record<string, unknown> } }
  | { kind: "answer_question"; args: { session: string; request_id: string; input: Record<string, unknown>; answers: Record<string, string> } }
  | { kind: "interrupt"; args: { session: string } }
  | { kind: "stop_session"; args: { session: string } }
  | { kind: "start_session"; args: { workspace_id: string; repo_id: string; prompt: string } };

export const reply = (session: string, text: string): Command => ({ kind: "send_prompt", args: { session, text: text.trim() } });

export const allow = (session: string, a: Extract<PendingAsk, { kind: "permission" }>): Command =>
  ({ kind: "permission_response", args: { session, request_id: a.requestId, decision: { behavior: "allow", updatedInput: a.input } } });

export const deny = (session: string, a: PendingAsk, note?: string): Command =>
  ({ kind: "permission_response", args: { session, request_id: a.requestId, decision: { behavior: "deny", message: note?.trim() || "Denied from the phone." } } });

// picks: question → chosen labels. Several picks (multiSelect) are sent joined, as the desktop does.
export const answer = (session: string, a: Extract<PendingAsk, { kind: "question" }>, picks: Record<string, string[]>): Command =>
  ({ kind: "answer_question", args: { session, request_id: a.requestId, input: a.input, answers: Object.fromEntries(Object.entries(picks).filter(([, v]) => v.length).map(([q, v]) => [q, v.join(", ")])) } });

export const interrupt = (session: string): Command => ({ kind: "interrupt", args: { session } });

export const start = (workspaceId: string, repoId: string, prompt: string): Command =>
  ({ kind: "start_session", args: { workspace_id: workspaceId, repo_id: repoId, prompt: prompt.trim() } });

/** Every question has at least one pick. */
export const answered = (a: Extract<PendingAsk, { kind: "question" }>, picks: Record<string, string[]>) =>
  a.questions.every((q) => (picks[q.question] ?? []).length > 0);

export const send = <T = unknown>(c: Command) => invoke<T>("remote_command", { command: c });
