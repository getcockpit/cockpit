import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MrEvent } from "./types";

export type Block = {
  id: string; section: string; status: string; takeaway: string; key: string; body: string;
  data: { options?: { label: string; description: string }[] } | null; order: number; decision: string | null; updated: string;
};
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
};
