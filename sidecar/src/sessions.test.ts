import { expect, test } from "bun:test";
import { Sessions, type QueryFn } from "./sessions";

// The turn-ending hook (MR-174), driven in-process: a scripted query sends an assistant message,
// calls an mr tool, and asks the PostToolBatch hook whether to go on.
type Hook = (input: { agent_id?: string }) => Promise<{ continue?: boolean }>;
async function batch(opts: { tool: string; endTurn?: "always" | "after_reply"; text?: string; agent?: string }) {
  const out: Record<string, unknown>[] = [];
  let decided: (r: { continue?: boolean }) => void = () => {};
  const verdict = new Promise<{ continue?: boolean }>((r) => (decided = r));
  let call: (tool: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({});
  const query: QueryFn = ({ prompt, options }) => {
    const hook = (options.hooks as { PostToolBatch: { hooks: Hook[] }[] }).PostToolBatch[0].hooks[0];
    async function* run() {
      for await (const _ of prompt) {
        const content = [...(opts.text ? [{ type: "text", text: opts.text }] : []), { type: "tool_use", name: `mcp__mr__${opts.tool}`, input: {} }];
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "m1", content } };
        await call(opts.tool, {});
        decided(await hook({ agent_id: opts.agent }));
        return;
      }
    }
    return Object.assign(run(), { interrupt: async () => {}, close: () => {} }) as ReturnType<QueryFn>;
  };
  const sessions = new Sessions((m) => {
    out.push(m);
    if (m.type === "tool_call") sessions.handle({ type: "tool_result", session: "s", call_id: (m as { call_id: string }).call_id, text: "ok", end_turn: opts.endTurn });
  }, query, () => "/bin/true", (_s, _t, c) => { call = c; return {}; });
  sessions.handle({ type: "start", session: "s", cwd: "/tmp", prompt: "go", tools: [{ name: opts.tool, description: "", params: {} }] } as never);
  return verdict;
}

test("a shown view ends the turn after its batch", async () => {
  expect(await batch({ tool: "render_view", endTurn: "always" })).toEqual({ continue: false });
});

test("a closed plan ends the turn only when the same message holds the reply", async () => {
  expect(await batch({ tool: "plan_set", endTurn: "after_reply", text: "Done. Next: \"Merge it\"" })).toEqual({ continue: false });
  expect(await batch({ tool: "plan_set", endTurn: "after_reply" })).toEqual({});
});

test("other tools, and subagent batches, never end the main turn", async () => {
  expect(await batch({ tool: "title_set", text: "Looking" })).toEqual({});
  expect(await batch({ tool: "render_view", endTurn: "always", agent: "a1" })).toEqual({});
});
