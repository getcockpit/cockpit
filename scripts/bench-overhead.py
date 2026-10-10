"""Summarise a bench-overhead.sh run: per task and mode, the mean of turns, tokens, time and cost."""
import collections, glob, json, os, statistics, sys

out = sys.argv[1]
rows = collections.defaultdict(list)
for f in sorted(glob.glob(os.path.join(out, "*.jsonl"))):
    name, mode, _ = os.path.basename(f).rsplit(".", 2)
    task = name.rsplit("-", 1)[0]
    tools, result, calls = collections.Counter(), None, set()
    for line in open(f):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("type") == "assistant":
            calls.add(m["message"]["id"])  # one id per model call; num_turns counts each tool result
            for c in m["message"].get("content", []):
                if c.get("type") == "tool_use":
                    tools[c["name"]] += 1
        if m.get("type") == "result":
            result = m
    if not result:
        print(f"no result: {f}", file=sys.stderr)
        continue
    mu = result.get("modelUsage", {})
    tok = lambda k: sum(v.get(k, 0) for v in mu.values())
    rows[(task, mode)].append({
        "calls": len(calls), "turns": result.get("num_turns", 0),
        "secs": result.get("duration_ms", 0) / 1000,
        "input": tok("inputTokens"), "cache_write": tok("cacheCreationInputTokens"),
        "cache_read": tok("cacheReadInputTokens"), "output": tok("outputTokens"),
        "cost": result.get("total_cost_usd", 0),
        "tools": sum(tools.values()), "mr_tools": sum(n for t, n in tools.items() if "mcp__mr__" in t or t == "ToolSearch"),
        "tool_names": dict(tools),
    })

keys = ["calls", "turns", "secs", "input", "cache_write", "cache_read", "output", "cost", "tools", "mr_tools"]
summary = {}
for (task, mode), rs in sorted(rows.items()):
    summary.setdefault(task, {})[mode] = {k: round(statistics.mean(r[k] for r in rs), 4) for k in keys} | {"n": len(rs), "tool_names": [r["tool_names"] for r in rs]}
print(json.dumps(summary, indent=1))
