import { claudeLaunch, NO_CLAUDE } from "./claude-path";
import type { Outbound } from "./protocol";
import type { QueryFn } from "./sessions";

// One tool-less turn for the app's own needs (picker layer 3, MR-21): no tools, no project
// settings or hooks, not saved as a resumable session, so it never shows up as a user session.
export async function oneshot(
  query: QueryFn,
  claudePath: string | undefined,
  m: { id: string; prompt: string; system: string; model?: string; env?: Record<string, string> },
  emit: (o: Outbound) => void,
): Promise<void> {
  async function* prompt() {
    yield { type: "user" as const, message: { role: "user" as const, content: m.prompt }, parent_tool_use_id: null };
  }
  const options: Record<string, unknown> = {
    model: m.model ?? "haiku",
    systemPrompt: m.system,
    tools: [],
    maxTurns: 1,
    settingSources: [],
    persistSession: false,
    env: m.env ? { ...process.env, ...m.env } : undefined,
    canUseTool: async () => ({ behavior: "deny", message: "no tools in a one-shot" }),
  };
  const t0 = Date.now();
  try {
    if (!claudePath) throw new Error(NO_CLAUDE);
    Object.assign(options, claudeLaunch(claudePath).sdk);
    let text = "";
    let ok = false;
    for await (const msg of query({ prompt: prompt(), options })) {
      const x = msg as { type?: string; is_error?: boolean; result?: string; message?: { content?: { type: string; text?: string }[] } };
      if (x.type === "assistant") text += (x.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      if (x.type === "result") { ok = !x.is_error; if (typeof x.result === "string" && x.result) text = x.result; }
    }
    emit({ type: "oneshot_result", id: m.id, ok, text, ms: Date.now() - t0 });
  } catch (e) {
    emit({ type: "oneshot_result", id: m.id, ok: false, text: "", ms: Date.now() - t0, error: String(e) });
  }
}
