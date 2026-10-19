import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "./listen";
import type { MrEvent, SessionState, ViewBlock } from "./types";
import { api } from "./store";

export type Block = {
  id: string; section: string; status: string; takeaway: string; key: string; body: string;
  data: { options?: { label: string; description: string }[]; multiSelect?: boolean } | null; order: number; decision: string | null; updated: string;
  since?: number; was?: string | null; // version it last changed in, and its takeaway before (MR-51)
  view?: ViewBlock[] | null; // catalog blocks drawn with it (MR-100)
};

// The catalog blocks a block draws, if any.
export const blockView = (b: Block): ViewBlock[] => (Array.isArray(b.view) ? b.view : []);
export type Doc = {
  id: string; title: string; session_id: string | null; version: number;
  kind?: string; // "brief": a catch-up brief (MR-116)
  blocks: Record<string, Block>; pending_notes: [string, string][]; pending_changes: string[];
  build_sessions?: string[]; // sessions started from it with Build it, oldest first (MR-118)
  updated_at?: number; // when anything last happened to it, ms (MR-151)
  shipped_at?: number | null; // when its builds merged or you marked it shipped (MR-151)
};

// Lifecycle (decision 38, MR-151): drafting → ready → building → shipped, then Done archives it.
export type DocStage = "drafting" | "ready" | "building" | "shipped";
export const STAGE_LABEL: Record<DocStage, string> = { drafting: "Drafting", ready: "Ready to build", building: "Building", shipped: "Shipped" };
/** A doc idle this long before anyone builds it shows on the Wall (decision 38: 3 days). */
export const STALL_MS = 3 * 24 * 3600_000;

/** The builds that still count: started with Build it and not archived (dropped builds don't). */
export const liveBuilds = (d: Doc, sessions: Record<string, SessionState>): SessionState[] =>
  (d.build_sessions ?? []).map((id) => sessions[id]).filter((s): s is SessionState => !!s && !s.archivedAt);

export function docStage(d: Doc, sessions: Record<string, SessionState>): DocStage {
  if (d.shipped_at) return "shipped";
  if (liveBuilds(d, sessions).length) return "building";
  return Object.values(d.blocks).some(isOpenQuestion) ? "drafting" : "ready";
}

/** Drafting or ready, and untouched for STALL_MS: build it or drop it. Briefs have no lifecycle. */
export const isStalled = (d: Doc, sessions: Record<string, SessionState>, now: number) => {
  const st = docStage(d, sessions);
  return !isBrief(d) && (st === "drafting" || st === "ready") && !!d.updated_at && now - d.updated_at > STALL_MS;
};

/** The docs a session shows in Focus: the ones it wrote and the ones it builds (MR-118). */
export const docsOf = (docs: Doc[], sessionId: string) => docs.filter((d) => d.session_id === sessionId || d.build_sessions?.includes(sessionId));

/** Which working doc a session works on, and how: it builds it (Build it) or it plans it (wrote it).
 *  Build wins when both, and the newest doc wins among several. Briefs don't tag. */
export function docRole(docs: Doc[], sessionId: string): { doc: Doc; role: "plan" | "build" } | null {
  const own = docs.filter((d) => !isBrief(d)).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const build = own.find((d) => d.build_sessions?.includes(sessionId));
  if (build) return { doc: build, role: "build" };
  const plan = own.find((d) => d.session_id === sessionId);
  return plan ? { doc: plan, role: "plan" } : null;
}

/** The Wall's doc groups (MR-168): each doc with the sessions that plan or build it (each session
 *  in one group, the one docRole picks), docs with none, and the sessions that belong to no doc. */
export function groupByDoc(docs: Doc[], sessionIds: string[]): { groups: { doc: Doc; sessions: { id: string; role: "plan" | "build" }[] }[]; idle: Doc[]; loose: string[] } {
  const by = new Map<string, { id: string; role: "plan" | "build" }[]>();
  const loose: string[] = [];
  for (const id of sessionIds) {
    const r = docRole(docs, id);
    if (r) by.set(r.doc.id, [...(by.get(r.doc.id) ?? []), { id, role: r.role }]);
    else loose.push(id);
  }
  // The plan session first, then builds oldest first.
  const rank = (x: { role: string }) => (x.role === "plan" ? 0 : 1);
  return {
    groups: docs.filter((d) => by.has(d.id)).map((doc) => ({ doc, sessions: by.get(doc.id)!.sort((a, b) => rank(a) - rank(b)) })),
    idle: docs.filter((d) => !by.has(d.id)),
    loose,
  };
}

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
  done: (d: Doc) => invoke("doc_archive", { docId: d.id, outcome: "done" }),
  drop: (d: Doc, reason?: string) => invoke("doc_archive", { docId: d.id, outcome: "dropped", reason: reason ?? null }),
  markShipped: (d: Doc) => invoke("doc_mark_shipped", { docId: d.id }),
  // The core records doc.shipped once every live build's branch is merged into main.
  checkShipped: (d: Doc, builds: SessionState[]) => invoke<boolean>("doc_check_shipped", { docId: d.id, builds: builds.map((s) => ({ session_id: s.id, repo: s.repo, branch: s.branch })) }),
  buildStarted: (d: Doc, sessionId: string) => invoke("doc_build_started", { docId: d.id, sessionId }),
  // Catch me up (MR-116): the core creates the brief doc and has it written; Continue builds the corrections.
  brief: (session: string) => invoke<{ doc_id: string; via: "session" | "cockpit" }>("brief_start", { session }),
  briefContinue: (d: Doc) => invoke<string | null>("brief_continue", { docId: d.id }),
};

export const isBrief = (d: Doc) => d.kind === "brief";

/** A pending change that is a decision on a question (the core writes them as `Decided "…": …`). */
export const isDecision = (change: string) => change.startsWith("Decided ");

const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
/** The brief's Continue button says what it will do: apply your decisions, send corrections, or nothing. */
export const continueLabel = (decisions: number, corrections: number) =>
  decisions > 0 ? `Apply ${n(decisions, "decision")}${corrections > 0 ? ` + ${n(corrections, "correction")}` : ""} and continue`
  : corrections > 0 ? `Continue with ${n(corrections, "correction")}` : "Continue, nothing to correct";

/** Continue on a brief: your corrections go into the same session (queued if it's mid-turn); with
 *  none, nothing is sent (decided: close silently). Returns whether anything was sent. */
export async function continueBrief(d: Doc, session: SessionState | null | undefined): Promise<boolean> {
  const msg = await docApi.briefContinue(d);
  if (msg && d.session_id) await api.send(session?.id ?? d.session_id, msg);
  return !!msg;
}

/** Build it: starts a session that implements the doc, in the plan session's folder, and links it
 *  to the doc so each can open the other (MR-118). Returns the session id. */
export async function buildDoc(d: Doc, session: SessionState | null | undefined): Promise<string> {
  const id = await api.start(session?.cwd ?? "~/", `Implement the plan in working doc "${d.title}" (doc_id ${d.id}). First read it with the mr doc_read tool and follow its decisions. If you learn something that changes the plan, update the doc's blocks with doc_set_block and add a [log] block. When the work is done, add a [log] block "What shipped" with doc_set_block: what was built, where it deviated from the plan, and any follow-ups.`, "blank");
  await docApi.buildStarted(d, id);
  return id;
}

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
  // A brief waits for Continue instead: you may still be marking its risks.
  if (!stillOpen && session && !isBrief(d)) await sendDocFeedback(d, session, false).catch(() => {});
}
