# MR-2 spike findings: the Agent SDK against the real `claude`

Probe: `bun run spike/probe.ts` (2026-10-09). SDK `@anthropic-ai/claude-agent-sdk` 0.3.295, Claude Code 2.1.295. Raw output is in `../fixtures/`.

## Confirmed

| Question | Answer |
|---|---|
| Runs on the user's subscription? | Yes. `system/init.apiKeySource` is `"none"` (claude.ai login), with model `claude-opus-5-5`. No API key, no `--bare`. |
| Approval callback? | `canUseTool(toolName, input, { signal, suggestions, decisionReason, mcpServer })` returns `{behavior:"allow", updatedInput}` or `{behavior:"deny", message, interrupt?}`. Read-only Bash (`ls`) didn't ask. |
| Claude's questions? | `AskUserQuestion` goes through `canUseTool`. Answer by returning `updatedInput` with `answers: { [questionText]: label }`; Claude received "blue". |
| In-process MCP tools (doc tools)? | `createSdkMcpServer({ tools: [tool(name, desc, zodShape, handler)] })` in `mcpServers`. They're deferred: Claude found ours through `ToolSearch` before calling `mcp__mr__doc_read`. The call arrives with `mcpServer.source === "sdk"`. |
| Usage limits for the lamps? | `rate_limit_event.rate_limit_info.unifiedWindows.five_hour.utilization` (0.49 here) and `resetsAt`. |
| Structured results for the plain-code picker? | Every `user` tool result carries `tool_use_result`, e.g. Bash `{stdout, stderr, interrupted}` and AskUserQuestion `{questions, answers}`. No text parsing needed. |
| Session id for resume? | `system/init.session_id`. Pass it as `options.resume` later. |

## Decisions this forces

1. **Pick the executable explicitly.** `command -v claude` resolved to cmux's bundled copy. Order: `MR_CLAUDE_PATH`, then `~/.local/bin/claude` (native installer), then the first `claude` on PATH that isn't inside an `.app` bundle, then the SDK's bundled binary.
2. **Doc tool descriptions must be explicit**, because tools are deferred and Claude has to find them by search.
3. **`settingSources: []` still loads user hooks and claude.ai connectors.** That's fine, but session start pays for `hook_started`/`hook_response`. We keep the user's normal setup.

## Message types seen

`system/hook_started`, `system/hook_response`, `system/init`, `rate_limit_event`, `assistant` (text, thinking, tool_use), `user` (tool_result + tool_use_result), `system/thinking_tokens`, `result/success`.
