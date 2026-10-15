// Adding an MCP server from /mcp: the form's text into what `claude mcp add-json` takes.
export type McpTransport = "stdio" | "http" | "sse";
export type McpScope = "local" | "project" | "user";
export type McpAddForm = { name: string; transport: McpTransport; target: string; pairs: string };
export type McpAddConfig = { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> } | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

// A command line as a shell would split it: spaces separate, quotes group, backslash escapes.
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "", quote: string | null = null, any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i]; else cur += c; }
    else if (c === '"' || c === "'") { quote = c; any = true; }
    else if (c === "\\" && i + 1 < line.length) { cur += line[++i]; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ""; any = false; }
    else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

// One pair per line: KEY=value for env, Name: value for headers. Blank lines are skipped.
export function parsePairs(text: string, sep: "=" | ":"): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    if (i <= 0) return `"${line}" isn't ${sep === "=" ? "KEY=value" : "Name: value"}`;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// The config, or why the form isn't ready.
export function buildConfig(f: McpAddForm): McpAddConfig | string {
  if (!/^[A-Za-z0-9_-]+$/.test(f.name)) return "Name: letters, digits, - and _";
  if (f.name === "mr") return "mr is Cockpit's own server";
  const pairs = parsePairs(f.pairs, f.transport === "stdio" ? "=" : ":");
  if (typeof pairs === "string") return pairs;
  const extra = Object.keys(pairs).length ? pairs : undefined;
  if (f.transport === "stdio") {
    const [command, ...args] = splitCommand(f.target);
    if (!command) return "Command: what starts the server, e.g. npx -y @modelcontextprotocol/server-filesystem ~/code";
    return { type: "stdio", command, ...(args.length ? { args } : {}), ...(extra ? { env: extra } : {}) };
  }
  const url = f.target.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return "URL: http(s)://…";
  return { type: f.transport, url, ...(extra ? { headers: extra } : {}) };
}
