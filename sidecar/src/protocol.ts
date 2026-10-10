// The NDJSON protocol between the Rust core and the sidecar. One object per line.
// `session` is the app's own session id (stable across resumes); `sdk_session_id` is Claude's.

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
// One row of the model picker: what Claude Code offers this login (supportedModels).
export type ModelRow = { value: string; resolved: string | null; displayName: string; description: string; efforts: Effort[] };

export type ToolSpec = { name: string; description: string; params: Record<string, "string" | "number" | "boolean" | "object" | "array"> };

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
  | { type: "limits"; env?: Record<string, string> }
  | { type: "models"; env?: Record<string, string> }
  | { type: "oneshot"; id: string; prompt: string; system: string; model?: string; env?: Record<string, string> };

export type Outbound =
  | { type: "ready"; version: string; runtime: string; claude: string }
  | { type: "pong"; id: string | null; at: number }
  | { type: "session_started"; session: string; sdk_session_id: string; model?: string; cwd?: string }
  | { type: "sdk"; session: string; message: unknown }
  | { type: "permission_request"; session: string; request_id: string; tool: string; input: Record<string, unknown>; suggestions: unknown[] | null; decision_reason: string | null; mcp_server: { name: string; source: string } | null }
  | { type: "tool_call"; session: string; call_id: string; tool: string; args: Record<string, unknown> }
  | { type: "session_ended"; session: string; ok: boolean; reason?: string }
  | { type: "limits"; available: boolean; plan?: string | null; five_hour?: { utilization: number; resetsAt: number | null } | null; seven_day?: { utilization: number; resetsAt: number | null } | null; error?: string }
  | { type: "model_set"; session: string; model?: string | null; effort?: Effort | null; ok: boolean; error?: string }
  | { type: "models"; models: ModelRow[]; error?: string }
  | { type: "oneshot_result"; id: string; ok: boolean; text: string; ms: number; error?: string }
  | { type: "error"; session?: string; error: string };
