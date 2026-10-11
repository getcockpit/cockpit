import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "./listen";
import type { MrEvent, SessionState, ViewBlock } from "./types";
import { api } from "./store";

export type Block = {
  id: string; section: string; status: string; takeaway: string; key: string; body: string;
  data: { options?: { label: string; description: string }[] } | null; order: number; decision: string | null; updated: string;
  since?: number; was?: string | null; // version it last changed in, and its takeaway before (MR-51)
  view?: ViewBlock[] | null; // catalog blocks drawn with it (MR-100)
};

// The catalog blocks a block draws, if any.
export const blockView = (b: Block): ViewBlock[] => (Array.isArray(b.view) ? b.view : []);
export type Doc = {
  id: string; title: string; session_id: string | null; version: number;
  blocks: Record<string, Block>; pending_notes: [string, string][]; pending_changes: string[];
};

export const SECTIONS = ["goal", "scope", "success", "design", "risk", "question", "components", "verification", "log"] as const;
export const SECTION_LABEL: Record<string, string> = {
  goal: "Goal", scope: "Scope", success: "Success criteria", design: "Design", risk: "Risk",
  question: "Open question", components: "Components", verification: "Verification", log: "Iteration log",
};

export function orderedBlocks(d: Doc): Block[] {
  return Object.values(d.blocks).sort((a, b) => (SECTIONS.indexOf(a.section as never) - SECTIONS.indexOf(b.section as never)) || a.order - b.order);
}

export const isOpenQuestion = (b: Block) => b.section === "question" && !b.decision;

// Docs live in the Rust core (folded from the event log); refetch whenever a doc event lands.
export function useDocs(): Doc[] {
  const [docs, setDocs] = useState<Doc[]>([]);
  useEffect(() => {
    const load = () => invoke<Doc[]>("docs_list").then(setDocs).catch(() => {});
    load();
    const un = listen<MrEvent>("mr-event", ({ payload }) => {
      if (payload.kind.startsWith("doc.") || payload.kind.startsWith("ui.doc_")) load();
    });
    return () => { un.then((f) => f()); };
  }, []);
  return docs;
}

export const docApi = {
  note: (d: Doc, blockId: string, text: string) => invoke("event_append", { sessionId: d.session_id, kind: "ui.doc_note", payload: { doc_id: d.id, block_id: blockId, text }, anchor: `doc:${d.id}:${blockId}` }),
  decide: (d: Doc, blockId: string, choice: string) => invoke("event_append", { sessionId: d.session_id, kind: "ui.doc_decision", payload: { doc_id: d.id, block_id: blockId, choice }, anchor: `doc:${d.id}:${blockId}` }),
  edit: (d: Doc, blockId: string, field: "takeaway" | "key" | "body", value: string) => invoke("event_append", { sessionId: d.session_id, kind: "ui.doc_edit", payload: { doc_id: d.id, block_id: blockId, field, value }, anchor: `doc:${d.id}:${blockId}` }),
  feedback: (d: Doc, regenerate: boolean) => invoke<string>("doc_feedback", { docId: d.id, regenerate }),
  archive: (d: Doc) => invoke("doc_archive", { docId: d.id }),
};

/** Sends the user's notes, edits and decisions on a doc to Claude: to its plan session if it's
 *  still open, otherwise to a new plan session in the same folder. Returns the session id. The
 *  core only builds the message (doc_feedback); delivering it is always the UI's job. */
export async function sendDocFeedback(d: Doc, session: SessionState | null | undefined, regenerate: boolean): Promise<string> {
  const msg = await docApi.feedback(d, regenerate);
  if (session && session.status !== "ended" && session.status !== "error") { await api.send(session.id, msg); return session.id; }
  return api.start(session?.cwd ?? "~/", msg, "plan");
}

/** Records a decision on an open question. Deciding the last open one hands the doc back to its
 *  plan session (same behaviour from the queue and the map), so the plan carries on by itself. */
export async function decideQuestion(d: Doc, blockId: string, label: string, session: SessionState | null | undefined): Promise<void> {
  await docApi.decide(d, blockId, label);
  const stillOpen = Object.values(d.blocks).some((x) => isOpenQuestion(x) && x.id !== blockId);
  if (!stillOpen && session) await sendDocFeedback(d, session, false).catch(() => {});
}
