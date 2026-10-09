import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { McpFactory } from "./sessions";

// Builds the in-process `mr` MCP server for one session. Every tool call is relayed to the
// Rust core (which owns docs and state) and answered with whatever text it sends back.
export const relayMcp: McpFactory = (_session, specs, call) => {
  // Params are optional so Claude can update a single field; the core validates what it needs.
  const zt = { string: z.string().optional(), number: z.number().optional(), boolean: z.boolean().optional(), object: z.record(z.string(), z.unknown()).optional(), array: z.array(z.unknown()).optional() } as const;
  return createSdkMcpServer({
    name: "mr",
    version: "0.1.0",
    tools: specs.map((s) =>
      tool(s.name, s.description, Object.fromEntries(Object.entries(s.params).map(([k, t]) => [k, zt[t]])), async (args) => {
        const r = await call(s.name, args as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: r.text }], isError: r.is_error ?? false };
      }),
    ),
  }) as unknown as Record<string, unknown>;
};
