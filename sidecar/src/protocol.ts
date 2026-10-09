// The NDJSON protocol between the Rust core and the sidecar. One object per line.
// `session` is the app's own session id (stable across resumes); `sdk_session_id` is Claude's.

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type ToolSpec = { name: string; description: string; params: Record<string, "string" | "number" | "boolean" | "object"> };

export type Inbound =
  | { type: "ping"; id?: string }
  | { type: "start"; session: string; cwd: string; prompt: string; resume?: string; model?: string; tools?: ToolSpec[] }
  | { type: "send"; session: string; text: string }
  | { type: "interrupt"; session: string }
  | { type: "stop"; session: string }
  | { type: "permission_response"; session: string; request_id: string; decision: PermissionDecision }
  | { type: "tool_result"; session: string; call_id: string; text: string; is_error?: boolean };

export type Outbound =
  | { type: "ready"; version: string; runtime: string; claude: string }
  | { type: "pong"; id: string | null; at: number }
  | { type: "session_started"; session: string; sdk_session_id: string; model?: string; cwd?: string }
  | { type: "sdk"; session: string; message: unknown }
  | { type: "permission_request"; session: string; request_id: string; tool: string; input: Record<string, unknown>; suggestions: unknown[] | null; decision_reason: string | null; mcp_server: { name: string; source: string } | null }
  | { type: "tool_call"; session: string; call_id: string; tool: string; args: Record<string, unknown> }
  | { type: "session_ended"; session: string; ok: boolean; reason?: string }
  | { type: "error"; session?: string; error: string };
