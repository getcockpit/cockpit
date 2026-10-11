import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef } from "react";
import { pickDecision } from "../picker/pick";
import { needsQueue, type QueueItem } from "../picker/queue";
import { sessionTitle } from "../picker/title";
import { answerAsk } from "../screens/AskRow";
import { decideQuestion, type Doc } from "./docs";
import { listen } from "./listen";
import { api } from "./store";
import type { AppState, SessionState } from "./types";

// macOS notifications for the needs-you queue (MR-94). Each new item, while Cockpit is in the
// background, becomes one notification with the ask in it. Clicking it opens that decision (deep
// link); its quick answers or reply field answer it in place. The core only shows them.

export type Note = { key: string; session: string | null; title: string; subtitle: string; body: string; actions: string[]; reply: boolean };
export type Target = { workspace: string; session: string | null; doc: string | null };
type Response = { kind: "open" } | { kind: "action"; value: string } | { kind: "reply"; value: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const project = (s: SessionState) => (s.repo ?? s.cwd).split("/").filter(Boolean).pop() ?? s.cwd;
const base = (p: string) => p.split("/").pop() ?? p;

/** What a queue item says on the lock screen: what kind of decision, where it's from, and the ask itself. */
export function noteFor(item: QueueItem, sessions: Record<string, SessionState>, workspaceName: (id: string) => string | null): Note {
  const s = item.kind === "doc" ? (item.d.session_id ? sessions[item.d.session_id] : undefined) : item.s;
  const ws = s ? workspaceName(s.workspace) : null;
  const subtitle = clip([ws, s ? `${project(s)} / ${sessionTitle(s)}` : null].filter(Boolean).join(" · "), 90);
  const note = (title: string, body: string, actions: string[] = [], reply = false): Note => ({ key: item.key, session: s?.id ?? null, title, subtitle, body: clip(body.trim(), 240), actions, reply });
  switch (item.kind) {
    case "ask": {
      const { spec } = pickDecision(item.a);
      if (spec.component === "QuestionCard") {
        const [q, ...more] = spec.questions;
        const single = !more.length && !q.multiSelect;
        return note(q.header ? `Claude asks: ${q.header}` : "Claude asks", `${q.question}${more.length ? ` (+${more.length} more)` : ""}`, single ? q.options.map((o) => o.label).slice(0, 4) : []);
      }
      const yesNo = ["Allow", "Deny"];
      if (spec.component === "CommandCard") return note(spec.risk === "high" ? "Allow a risky command?" : "Allow a command?", `${spec.description ? `${spec.description}\n` : ""}$ ${spec.command}`, yesNo);
      if (spec.component === "DiffCard") return note(`Allow ${spec.tool === "Write" ? "a new file" : "an edit"}?`, `${base(spec.path)}  +${spec.added} −${spec.removed}\n${spec.why}`, yesNo);
      return note(`Allow ${spec.tool}?`, spec.summary || spec.why, yesNo);
    }
    case "prose": return item.options.length ? note("Claude is waiting on you", item.question, item.options) : note("Claude is waiting on you", item.question, [], true);
    case "flow": return note("Ready for you", item.what);
    case "fix": return note("Fix ready", "A god-mode fix is built. Apply it to your app.");
    case "doc": return note("Decision needed", `${item.d.title}: ${item.b.takeaway}`, (item.b.data?.options ?? []).map((o) => o.label).slice(0, 4));
  }
}

/** Where a click on the item lands: its session (in its workspace), or its doc. */
export function targetFor(item: QueueItem, sessions: Record<string, SessionState>): Target {
  if (item.kind === "doc") return { workspace: (item.d.session_id && sessions[item.d.session_id]?.workspace) || "personal", session: null, doc: item.d.id };
  return { workspace: item.s.workspace, session: item.s.id, doc: null };
}

/** Answers the item with a notification action or reply. False when it can't (then it opens instead). */
export async function answerFrom(item: QueueItem, r: Response, sessions: Record<string, SessionState>): Promise<boolean> {
  if (r.kind === "open") return false;
  const pick = (options: string[]) => options.find((o) => o === r.value) ?? null;
  switch (item.kind) {
    case "ask": {
      if (item.a.kind === "permission") {
        if (r.value === "Allow") await answerAsk(item.s, item.a, { kind: "allow" });
        else if (r.value === "Deny") await answerAsk(item.s, item.a, { kind: "deny" });
        else return false;
        return true;
      }
      const q = item.a.questions[0];
      const label = q && pick(q.options.map((o) => o.label));
      if (!label) return false;
      await answerAsk(item.s, item.a, { kind: "answer", answers: { [q.question]: label } });
      return true;
    }
    case "prose": {
      const text = r.kind === "reply" ? r.value : pick(item.options);
      if (!text) return false;
      await api.send(item.s.id, text);
      return true;
    }
    case "doc": {
      const label = pick((item.b.data?.options ?? []).map((o) => o.label));
      if (!label) return false;
      await decideQuestion(item.d, item.b.id, label, item.d.session_id ? sessions[item.d.session_id] : null);
      return true;
    }
    default: return false;
  }
}

// Anything already waiting when the app opens (or whose docs load just after) isn't news.
const SETTLE_MS = 3000;

/** Posts a notification for each new needs-you item while the window is in the background, and
 *  routes what you did with it: open → `onOpen(target)`, an answer → sent without opening. */
export function useNotify(all: AppState, docs: Doc[], onOpen: (t: Target) => void) {
  const queue = useMemo(() => needsQueue(Object.values(all.sessions), docs), [all.sessions, docs]);
  const seen = useRef<Set<string> | null>(null);
  const mounted = useRef(Date.now());
  const latest = useRef({ queue, all, onOpen });
  latest.current = { queue, all, onOpen };

  useEffect(() => {
    if (all.lastEventId === null) return; // still replaying
    const fresh = queue.filter((x) => !seen.current?.has(x.key));
    seen.current ??= new Set();
    for (const x of fresh) seen.current.add(x.key);
    if (Date.now() - mounted.current < SETTLE_MS || !all.notifications || document.hasFocus()) return;
    const name = (id: string) => (all.workspaces.length > 1 ? all.workspaces.find((w) => w.id === id)?.name ?? null : null);
    for (const x of fresh) void invoke("notify", { note: noteFor(x, all.sessions, name) }).catch(() => {});
  }, [queue, all.lastEventId, all.notifications, all.workspaces, all.sessions]);

  useEffect(() => {
    const off = listen<{ key: string; session: string | null; response: Response }>("mr-notify", ({ payload }) => {
      const { queue, all, onOpen } = latest.current;
      const item = queue.find((x) => x.key === payload.key);
      if (!item) {
        // Already answered (here or elsewhere): any response still takes you to where it was.
        const s = payload.session ? all.sessions[payload.session] : undefined;
        const doc = payload.key.startsWith("doc:") ? payload.key.split(":")[1] : null;
        if (doc || s) onOpen({ workspace: s?.workspace ?? "personal", session: doc ? null : s?.id ?? null, doc });
        return;
      }
      void answerFrom(item, payload.response, all.sessions).then((done) => {
        if (!done) onOpen(targetFor(item, all.sessions));
      }).catch((e) => window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Not answered: ${String(e).split("\n")[0]}` })));
    });
    return () => void off.then((f) => f());
  }, []);
}
