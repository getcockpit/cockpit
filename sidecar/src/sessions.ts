import type { Inbound, Outbound, PermissionDecision, ToolSpec } from "./protocol";

// The slice of the Agent SDK this module needs, so tests can inject a fake.
export type QueryFn = (params: { prompt: AsyncIterable<UserMsg>; options: Record<string, unknown> }) => AsyncIterable<unknown> & { interrupt(): Promise<unknown>; close?(): void };
export type McpFactory = (session: string, tools: ToolSpec[], call: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; is_error?: boolean }>) => Record<string, unknown> | undefined;
type UserMsg = { type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null };

// A push-based async queue: the prompt stream for one session, so follow-ups can be sent mid-run.
class Inbox implements AsyncIterable<UserMsg> {
  private items: UserMsg[] = [];
  private waiting: ((r: IteratorResult<UserMsg>) => void) | null = null;
  private closed = false;
  push(text: string) {
    const m: UserMsg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: m, done: false }); } else this.items.push(m);
  }
  close() { this.closed = true; if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined as never, done: true }); } }
  [Symbol.asyncIterator](): AsyncIterator<UserMsg> {
    return { next: () => {
      if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
      if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((r) => { this.waiting = r; });
    } };
  }
}

type Live = { inbox: Inbox; q: ReturnType<QueryFn> | null; pending: Map<string, (d: PermissionDecision) => void>; calls: Map<string, (r: { text: string; is_error?: boolean }) => void> };

export class Sessions {
  private live = new Map<string, Live>();
  private seq = 0;
  constructor(private emit: (m: Outbound) => void, private query: QueryFn, private claudePath: string | undefined, private mcp: McpFactory = () => undefined) {}

  handle(m: Inbound): void {
    switch (m.type) {
      case "start": return this.start(m);
      case "send": return void this.with(m.session, (s) => s.inbox.push(m.text));
      case "interrupt": return void this.with(m.session, (s) => { void s.q?.interrupt(); });
      case "stop": return void this.with(m.session, (s) => { s.inbox.close(); s.q?.close?.(); });
      case "permission_response": return void this.with(m.session, (s) => {
        const r = s.pending.get(m.request_id);
        if (!r) return this.emit({ type: "error", session: m.session, error: `no pending request ${m.request_id}` });
        s.pending.delete(m.request_id); r(m.decision);
      });
      case "tool_result": return void this.with(m.session, (s) => {
        const r = s.calls.get(m.call_id);
        if (!r) return this.emit({ type: "error", session: m.session, error: `no pending tool call ${m.call_id}` });
        s.calls.delete(m.call_id); r({ text: m.text, is_error: m.is_error });
      });
    }
  }

  private with(session: string, f: (s: Live) => void) {
    const s = this.live.get(session);
    if (!s) return this.emit({ type: "error", session, error: "unknown session" });
    f(s);
  }

  private start(m: Extract<Inbound, { type: "start" }>) {
    if (this.live.has(m.session)) return this.emit({ type: "error", session: m.session, error: "session already running" });
    const s: Live = { inbox: new Inbox(), q: null, pending: new Map(), calls: new Map() };
    this.live.set(m.session, s);
    s.inbox.push(m.prompt);

    const callTool = (tool: string, args: Record<string, unknown>) => new Promise<{ text: string; is_error?: boolean }>((resolve) => {
      const call_id = `c${++this.seq}`;
      s.calls.set(call_id, resolve);
      this.emit({ type: "tool_call", session: m.session, call_id, tool, args });
    });
    const mcpServer = m.tools?.length ? this.mcp(m.session, m.tools, callTool) : undefined;

    const options: Record<string, unknown> = {
      cwd: m.cwd,
      resume: m.resume,
      // Per-workspace Claude config (CLAUDE_CONFIG_DIR) keeps memories and transcripts apart.
      env: m.env ? { ...process.env, ...m.env } : undefined,
      model: m.model,
      pathToClaudeCodeExecutable: this.claudePath,
      systemPrompt: m.append_system_prompt ? { type: "preset", preset: "claude_code", append: m.append_system_prompt } : undefined,
      mcpServers: mcpServer ? { mr: mcpServer } : undefined,
      canUseTool: (tool: string, input: Record<string, unknown>, opts: { signal?: AbortSignal; suggestions?: unknown[]; decisionReason?: string; mcpServer?: { name: string; source: string } }) =>
        new Promise<PermissionDecision>((resolve) => {
          const request_id = `p${++this.seq}`;
          s.pending.set(request_id, resolve);
          opts.signal?.addEventListener("abort", () => { if (s.pending.delete(request_id)) resolve({ behavior: "deny", message: "aborted" }); });
          this.emit({ type: "permission_request", session: m.session, request_id, tool, input, suggestions: opts.suggestions ?? null, decision_reason: opts.decisionReason ?? null, mcp_server: opts.mcpServer ?? null });
        }),
    };

    void (async () => {
      try {
        s.q = this.query({ prompt: s.inbox, options });
        for await (const msg of s.q) {
          const x = msg as { type?: string; subtype?: string; session_id?: string; model?: string; cwd?: string };
          if (x.type === "system" && x.subtype === "init") this.emit({ type: "session_started", session: m.session, sdk_session_id: x.session_id ?? "", model: x.model, cwd: x.cwd });
          this.emit({ type: "sdk", session: m.session, message: msg });
          // One prompt per turn: when a turn finishes and nothing more is queued, the session stays open for `send`.
        }
        this.emit({ type: "session_ended", session: m.session, ok: true });
      } catch (e) {
        this.emit({ type: "session_ended", session: m.session, ok: false, reason: e instanceof Error ? e.message : String(e) });
      } finally {
        for (const r of s.pending.values()) r({ behavior: "deny", message: "session ended" });
        this.live.delete(m.session);
      }
    })();
  }
}
