import { claudeLaunch, NO_CLAUDE, type ClaudeLaunch } from "./claude-path";
import { userContent } from "./attachments";
import type { Attachment, CommandRow, Effort, Inbound, McpAction, McpAddConfig, McpScope, McpServer, ModelRow, Outbound, PermissionDecision, PermissionMode, ToolSpec } from "./protocol";

// The slice of the Agent SDK this module needs, so tests can inject a fake.
export type QueryFn = (params: { prompt: AsyncIterable<UserMsg>; options: Record<string, unknown> }) => AsyncIterable<unknown> & {
  interrupt(): Promise<unknown>;
  close?(): void;
  setModel?(model?: string): Promise<void>;
  applyFlagSettings?(settings: { effortLevel?: Effort | null }): Promise<void>;
  supportedModels?(): Promise<{ value: string; resolvedModel?: string; displayName: string; description: string; supportedEffortLevels?: Effort[] }[]>;
  supportedCommands?(): Promise<{ name: string; description: string; argumentHint: string; aliases?: string[]; builtin?: boolean }[]>;
  mcpServerStatus?(): Promise<SdkMcpStatus[]>;
  reconnectMcpServer?(name: string): Promise<void>;
  toggleMcpServer?(name: string, enabled: boolean): Promise<void>;
  setMcpServers?(servers: Record<string, unknown>): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>;
  setPermissionMode?(mode: PermissionMode): Promise<void>;
};
type SdkMcpStatus = { name: string; status: string; source?: string; scope?: string; error?: string; serverInfo?: { version: string }; config?: { url?: string }; tools?: { name: string }[] };
export type { ModelRow };
export type McpFactory = (session: string, tools: ToolSpec[], call: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; is_error?: boolean }>) => Record<string, unknown> | undefined;
type UserMsg = { type: "user"; message: { role: "user"; content: string | Record<string, unknown>[] }; parent_tool_use_id: null };

// A push-based async queue: the prompt stream for one session, so follow-ups can be sent mid-run.
class Inbox implements AsyncIterable<UserMsg> {
  private items: UserMsg[] = [];
  private waiting: ((r: IteratorResult<UserMsg>) => void) | null = null;
  private closed = false;
  push(text: string, attachments?: Attachment[]) {
    const m: UserMsg = { type: "user", message: { role: "user", content: userContent(text, attachments) }, parent_tool_use_id: null };
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

// dynamic: the servers this session runs beyond its config (mr, and any added from /mcp), since
// setMcpServers replaces that whole set each time.
type Live = { inbox: Inbox; q: ReturnType<QueryFn> | null; cwd: string; env?: Record<string, string>; dynamic: Record<string, unknown>; init: { skills: string[]; terminal: string[] }; switching: Promise<void>; pending: Map<string, (d: PermissionDecision) => void>; calls: Map<string, (r: { text: string; is_error?: boolean }) => void>; endTurn?: "always" | "after_reply"; replied?: { id: string; text: boolean } };

// Whether the main thread's latest assistant message has text: the SDK streams one message per
// content block, all with the same id, before its tools run.
function noteReply(s: Live, msg: unknown) {
  const a = msg as { type?: string; parent_tool_use_id?: string | null; message?: { id?: string; content?: { type?: string; text?: string }[] } };
  if (a.type !== "assistant" || a.parent_tool_use_id || !a.message?.id) return;
  if (s.replied?.id !== a.message.id) s.replied = { id: a.message.id, text: false };
  if (Array.isArray(a.message.content) && a.message.content.some((b) => b.type === "text" && !!b.text?.trim())) s.replied.text = true;
}

export class Sessions {
  private live = new Map<string, Live>();
  private seq = 0;
  constructor(private emit: (m: Outbound) => void, private query: QueryFn, private claude: () => string | undefined, private mcp: McpFactory = () => undefined) {}

  handle(m: Inbound): void {
    switch (m.type) {
      case "start": return this.start(m);
      case "send": return void this.with(m.session, (s) => s.inbox.push(m.text, m.attachments));
      case "interrupt": return void this.with(m.session, (s) => { void s.q?.interrupt(); });
      case "set_model": return void this.with(m.session, (s) => { s.switching = s.switching.then(() => this.setModel(m.session, s, m.model, m.effort)); });
      case "set_permission_mode": return void this.with(m.session, (s) => {
        s.switching = s.switching.then(() => this.setPermissionMode(m.session, s, m.mode));
      });
      case "stop": return void this.with(m.session, (s) => { s.inbox.close(); s.q?.close?.(); });
      case "permission_response": return void this.with(m.session, (s) => {
        const r = s.pending.get(m.request_id);
        if (!r) return this.emit({ type: "error", session: m.session, error: `no pending request ${m.request_id}` });
        s.pending.delete(m.request_id); r(m.decision);
      });
      case "commands": return void this.with(m.session, (s) => void this.commands(m.session, s));
      case "mcp_status": return void this.with(m.session, (s) => void this.mcpStatus(m.session, s));
      case "mcp_action": return void this.with(m.session, (s) => void this.mcpAction(m.session, s, m.server, m.action));
      // One at a time, like switches: each setMcpServers call carries the whole dynamic set.
      case "mcp_add": return void this.with(m.session, (s) => { s.switching = s.switching.then(() => this.mcpAdd(m.session, s, m.server, m.scope, m.config)); });
      case "tool_result": return void this.with(m.session, (s) => {
        const r = s.calls.get(m.call_id);
        if (!r) return this.emit({ type: "error", session: m.session, error: `no pending tool call ${m.call_id}` });
        s.calls.delete(m.call_id); if (m.end_turn && s.endTurn !== "always") s.endTurn = m.end_turn; r({ text: m.text, is_error: m.is_error });
      });
    }
  }

  // Model and effort apply from the next request on, without restarting the conversation.
  // Switches run one at a time, in the order sent, so the last one asked for is the one that holds.
  private async setModel(session: string, s: Live, model: string | null | undefined, effort: Effort | null | undefined) {
    try {
      if (!s.q?.setModel || !s.q.applyFlagSettings) throw new Error("this SDK can't switch models mid-session");
      if (model !== undefined) await s.q.setModel(model ?? undefined);
      if (effort !== undefined) await s.q.applyFlagSettings({ effortLevel: effort });
      this.emit({ type: "model_set", session, model, effort, ok: true });
    } catch (e) {
      this.emit({ type: "model_set", session, model, effort, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async setPermissionMode(session: string, s: Live, mode: PermissionMode) {
    try {
      if (!s.q?.setPermissionMode) throw new Error("this SDK can't switch permission modes mid-session");
      await s.q.setPermissionMode(mode);
      this.emit({ type: "permission_mode_set", session, mode, ok: true });
    } catch (e) {
      this.emit({ type: "permission_mode_set", session, mode, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // The / menu's rows: every command and skill this session offers, marked so the menu knows a
  // skill from a built-in and which ones only work in Claude Code's own terminal.
  private async commands(session: string, s: Live) {
    try {
      if (!s.q?.supportedCommands) throw new Error("this SDK has no command list");
      const rows = await s.q.supportedCommands();
      const skills = new Set(s.init.skills), terminal = new Set(s.init.terminal);
      const commands: CommandRow[] = rows.map((r) => ({ name: r.name, description: r.description ?? "", hint: r.argumentHint ?? "", aliases: r.aliases ?? [], builtin: !!r.builtin, skill: skills.has(r.name), terminal: terminal.has(r.name) }));
      this.emit({ type: "commands", session, commands });
    } catch (e) {
      this.emit({ type: "commands", session, commands: [], error: e instanceof Error ? e.message : String(e) });
    }
  }

  // What /mcp shows: each server, its state, its tools.
  private async mcpStatus(session: string, s: Live, done?: { server: string; action: McpAction; ok: boolean; error?: string }) {
    try {
      if (!s.q?.mcpServerStatus) throw new Error("this SDK can't report MCP servers");
      const servers: McpServer[] = (await s.q.mcpServerStatus()).map((x) => ({ name: x.name, status: x.status, source: x.source ?? null, scope: x.scope ?? null, error: x.error ?? null, version: x.serverInfo?.version ?? null, url: x.config?.url ?? null, tools: (x.tools ?? []).map((t) => t.name) }));
      this.emit({ type: "mcp_status", session, servers, done });
    } catch (e) {
      this.emit({ type: "mcp_status", session, servers: [], done, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async mcpAction(session: string, s: Live, server: string, action: McpAction) {
    let done: { server: string; action: McpAction; ok: boolean; error?: string } = { server, action, ok: true };
    try {
      if (action === "reconnect") {
        if (!s.q?.reconnectMcpServer) throw new Error("this SDK can't reconnect MCP servers");
        await s.q.reconnectMcpServer(server);
      } else {
        if (!s.q?.toggleMcpServer) throw new Error("this SDK can't enable or disable MCP servers");
        await s.q.toggleMcpServer(server, action === "enable");
      }
    } catch (e) {
      done = { ...done, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    await this.mcpStatus(session, s, done);
  }

  // Adding a server from /mcp: saved with `claude mcp add-json` (in the session's own config dir and
  // folder, so scope means what it does in Claude Code), then attached to this session right away.
  private async mcpAdd(session: string, s: Live, server: string, scope: McpScope, config: McpAddConfig) {
    let done: { server: string; action: McpAction; ok: boolean; error?: string } = { server, action: "add", ok: true };
    try {
      const claude = this.claude();
      if (!claude) throw new Error(NO_CLAUDE);
      const run = claudeLaunch(claude);
      const proc = Bun.spawn([run.command, ...run.args, "mcp", "add-json", "--scope", scope, server, JSON.stringify(config)], { cwd: s.cwd, env: s.env ? { ...process.env, ...s.env } : process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (code !== 0) throw new Error((err.trim() || out.trim() || `claude mcp add-json exited with ${code}`).split("\n").slice(-3).join(" "));
      try {
        if (!s.q?.setMcpServers) throw new Error("this SDK can't add servers mid-session");
        const next = { ...s.dynamic, [server]: config };
        const r = await s.q.setMcpServers(next);
        s.dynamic = next;
        if (r.errors?.[server]) throw new Error(r.errors[server]);
      } catch (e) {
        throw new Error(`saved, but not attached to this session (resume it to load): ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      done = { ...done, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    await this.mcpStatus(session, s, done);
  }

  private with(session: string, f: (s: Live) => void) {
    const s = this.live.get(session);
    if (!s) return this.emit({ type: "error", session, error: "unknown session" });
    f(s);
  }

  private start(m: Extract<Inbound, { type: "start" }>) {
    if (this.live.has(m.session)) return this.emit({ type: "error", session: m.session, error: "session already running" });
    const claudePath = this.claude();
    if (!claudePath) return this.emit({ type: "session_ended", session: m.session, ok: false, reason: NO_CLAUDE });
    let launch: ClaudeLaunch;
    try { launch = claudeLaunch(claudePath); } catch (e) { return this.emit({ type: "session_ended", session: m.session, ok: false, reason: e instanceof Error ? e.message : String(e) }); }
    const s: Live = { inbox: new Inbox(), q: null, cwd: m.cwd, env: m.env, dynamic: {}, init: { skills: [], terminal: [] }, switching: Promise.resolve(), pending: new Map(), calls: new Map() };
    this.live.set(m.session, s);
    s.inbox.push(m.prompt, m.attachments);

    const callTool = (tool: string, args: Record<string, unknown>) => new Promise<{ text: string; is_error?: boolean }>((resolve) => {
      const call_id = `c${++this.seq}`;
      s.calls.set(call_id, resolve);
      this.emit({ type: "tool_call", session: m.session, call_id, tool, args });
    });
    const mcpServer = m.tools?.length ? this.mcp(m.session, m.tools, callTool) : undefined;
    if (mcpServer) s.dynamic.mr = mcpServer;

    const options: Record<string, unknown> = {
      cwd: m.cwd,
      resume: m.resume,
      // Per-workspace Claude config (CLAUDE_CONFIG_DIR) keeps memories and transcripts apart.
      env: m.env ? { ...process.env, ...m.env } : undefined,
      model: m.model,
      effort: m.effort,
      ...launch.sdk,
      systemPrompt: m.append_system_prompt ? { type: "preset", preset: "claude_code", append: m.append_system_prompt } : undefined,
      mcpServers: mcpServer ? { mr: mcpServer } : undefined,
      permissionMode: m.permission_mode,
      // A tool result the core marked end_turn stops the turn once its batch is done, so Claude
      // doesn't spend one more call re-reading the context only to stop (MR-174): a shown view
      // always, a closed plan only if the same message already holds Claude's reply text.
      // Subagent batches never stop the main turn; they only clear the flag.
      hooks: mcpServer ? { PostToolBatch: [{ hooks: [async (input: { agent_id?: string }) => {
        const stop = !input.agent_id && (s.endTurn === "always" || (s.endTurn === "after_reply" && !!s.replied?.text));
        s.endTurn = undefined;
        return stop ? { continue: false } : {};
      }] }] } : undefined,
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
          const isInit = x.type === "system" && x.subtype === "init";
          if (isInit) {
            const i = msg as { skills?: string[]; terminal_slash_commands?: string[] };
            s.init = { skills: i.skills ?? [], terminal: i.terminal_slash_commands ?? [] };
            this.emit({ type: "session_started", session: m.session, sdk_session_id: x.session_id ?? "", model: x.model, cwd: x.cwd });
          }
          this.emit({ type: "sdk", session: m.session, message: msg });
          noteReply(s, msg);
          // The / menu needs descriptions, which init doesn't carry: ask once the session is up.
          if (isInit) void this.commands(m.session, s);
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
