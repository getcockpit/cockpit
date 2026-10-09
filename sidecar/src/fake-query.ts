import type { QueryFn } from "./sessions";

// A scripted stand-in for the Agent SDK's query(), used by tests (MR_FAKE_QUERY=1).
// Per user message it: emits init once, asks permission for a Bash call, calls the first mr tool
// if one was registered, then emits an assistant reply and a result.
export const fakeQuery: QueryFn = ({ prompt, options }) => {
  const canUseTool = options.canUseTool as (t: string, i: Record<string, unknown>, o: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;
  const mcp = (options.mcpServers as Record<string, { instance?: unknown }> | undefined)?.mr;
  let interrupted = false;
  async function* run() {
    let first = true;
    for await (const user of prompt) {
      if (first) { yield { type: "system", subtype: "init", session_id: "sdk-fake-1", model: "fake", cwd: options.cwd, config_dir: (options.env as Record<string, string> | undefined)?.CLAUDE_CONFIG_DIR ?? null }; first = false; }
      const text = (user as { message: { content: string } }).message.content;
      const decision = await canUseTool("Bash", { command: "touch made-by-fake.txt" }, {});
      yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "touch made-by-fake.txt" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result" }] }, tool_use_result: { decision: decision.behavior } };
      if (mcp) yield { type: "system", subtype: "fake_mcp_registered" };
      if (interrupted) { interrupted = false; yield { type: "result", subtype: "error_during_execution", is_error: true }; continue; }
      yield { type: "assistant", message: { content: [{ type: "text", text: `echo: ${text}` }] } };
      yield { type: "result", subtype: "success", is_error: false, result: `echo: ${text}` };
    }
  }
  const it = run();
  return Object.assign(it, { interrupt: async () => { interrupted = true; }, close: () => {} });
};
