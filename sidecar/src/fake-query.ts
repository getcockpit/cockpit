import type { Effort } from "./protocol";
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
      if (first) { yield { type: "system", subtype: "init", session_id: "sdk-fake-1", model: "fake", cwd: options.cwd, skills: ["mr-task"], terminal_slash_commands: ["doctor"], config_dir: (options.env as Record<string, string> | undefined)?.CLAUDE_CONFIG_DIR ?? null, permissionMode: options.permissionMode ?? "default" }; first = false; }
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
  const usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({ rate_limits_available: true, subscription_type: "max", rate_limits: { five_hour: { utilization: 42, resets_at: "2026-10-09T20:00:00Z" }, seven_day: { utilization: 7, resets_at: null } } });
  const supportedModels = async () => [
    { value: "default", displayName: "Default (recommended)", description: "Opus for everything", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] as Effort[] },
    { value: "haiku", displayName: "Haiku", description: "Fastest", supportedEffortLevels: undefined },
  ];
  const setModel = async (model?: string) => { if (model === "broken") throw new Error("unknown model"); };
  const applyFlagSettings = async () => {};
  const setPermissionMode = async (mode: string) => { if (mode === "plan") throw new Error("not in this test"); };
  const supportedCommands = async () => [
    { name: "mcp", description: "Manage MCP servers", argumentHint: "", builtin: true },
    { name: "doctor", description: "Diagnose the install", argumentHint: "", builtin: true },
    { name: "mr-task", description: "Run one task", argumentHint: "<task>" },
  ];
  const servers = new Map([["docs", { status: "connected", tools: [{ name: "read" }] }], ["mail", { status: "needs-auth", tools: [] }]]);
  const mcpServerStatus = async () => [...servers].map(([name, x]) => ({ name, status: x.status, source: "claudeai", tools: x.tools }));
  const reconnectMcpServer = async (name: string) => { if (!servers.has(name)) throw new Error(`no server ${name}`); };
  const toggleMcpServer = async (name: string, on: boolean) => { const x = servers.get(name); if (!x) throw new Error(`no server ${name}`); x.status = on ? "connected" : "disabled"; };
  return Object.assign(it, { interrupt: async () => { interrupted = true; }, close: () => {}, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET, supportedModels, setModel, applyFlagSettings, setPermissionMode, supportedCommands, mcpServerStatus, reconnectMcpServer, toggleMcpServer });
};
