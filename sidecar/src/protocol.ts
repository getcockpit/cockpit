// The NDJSON protocol between the Rust core and the sidecar. One object per line.
// `session` is the app's own session id (stable across resumes); `sdk_session_id` is Claude's.

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
// One row of the model picker: what Claude Code offers this login (supportedModels).
export type ModelRow = { value: string; resolved: string | null; displayName: string; description: string; efforts: Effort[] };

// always_load: the schema sits in the cached prompt instead of behind ToolSearch (a round trip and a mid-turn cache write).
export type ToolSpec = { name: string; description: string; params: Record<string, "string" | "number" | "boolean" | "object" | "array">; always_load?: boolean };

// A slash command or skill the session offers (supportedCommands). terminal: its UX needs Claude Code's own terminal.
export type CommandRow = { name: string; description: string; hint: string; aliases: string[]; builtin: boolean; skill: boolean; terminal: boolean };
// One MCP server as /mcp would show it (mcpServerStatus).
export type McpServer = { name: string; status: string; source: string | null; scope: string | null; error: string | null; version: string | null; url: string | null; tools: string[] };
export type McpAction = "reconnect" | "enable" | "disable";

export type Inbound =
  | { type: "ping"; id?: string }
  | { type: "start"; session: string; cwd: string; prompt: string; resume?: string; model?: string; effort?: Effort; tools?: ToolSpec[]; append_system_prompt?: string; env?: Record<string, string> }
  | { type: "send"; session: string; text: string }
  | { type: "interrupt"; session: string }
  // Mid-session switch; null goes back to Claude Code's default. Omitted keys stay as they are.
  | { type: "set_model"; session: string; model?: string | null; effort?: Effort | null }
  | { type: "stop"; session: string }
  | { type: "permission_response"; session: string; request_id: string; decision: PermissionDecision }
  | { type: "tool_result"; session: string; call_id: string; text: string; is_error?: boolean }
  | { type: "commands"; session: string }
  | { type: "mcp_status"; session: string }
  | { type: "mcp_action"; session: string; server: string; action: McpAction }
  | { type: "limits"; env?: Record<string, string> }
  | { type: "models"; env?: Record<string, string> }
  | { type: "oneshot"; id: string; prompt: string; system: string; model?: string; env?: Record<string, string> };

export type Outbound =
  // claude: the binary it drives, null when Claude Code isn't installed. "claude" reports a later change.
  | { type: "ready"; version: string; runtime: string; claude: string | null }
  | { type: "claude"; claude: string | null }
  | { type: "pong"; id: string | null; at: number }
  | { type: "session_started"; session: string; sdk_session_id: string; model?: string; cwd?: string }
  | { type: "sdk"; session: string; message: unknown }
  | { type: "permission_request"; session: string; request_id: string; tool: string; input: Record<string, unknown>; suggestions: unknown[] | null; decision_reason: string | null; mcp_server: { name: string; source: string } | null }
  | { type: "tool_call"; session: string; call_id: string; tool: string; args: Record<string, unknown> }
  | { type: "session_ended"; session: string; ok: boolean; reason?: string }
  | { type: "limits"; available: boolean; plan?: string | null; five_hour?: { utilization: number; resetsAt: number | null } | null; seven_day?: { utilization: number; resetsAt: number | null } | null; error?: string }
  | { type: "model_set"; session: string; model?: string | null; effort?: Effort | null; ok: boolean; error?: string }
  | { type: "models"; models: ModelRow[]; error?: string }
  | { type: "commands"; session: string; commands: CommandRow[]; error?: string }
  // done: the action this answers, if any; its error when it failed (the list is still the fresh one).
  | { type: "mcp_status"; session: string; servers: McpServer[]; done?: { server: string; action: McpAction; ok: boolean; error?: string }; error?: string }
  | { type: "oneshot_result"; id: string; ok: boolean; text: string; ms: number; error?: string }
  | { type: "error"; session?: string; error: string };
