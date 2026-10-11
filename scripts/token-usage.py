#!/usr/bin/env python3
"""Token use per session, from the event log (no Claude usage).

  python3 -I scripts/token-usage.py [--db PATH] [--last N]

prefix = input + cache tokens of a session's first API call: the fixed cost every session
pays before the user's first word (system prompt, tool schemas, skills list, CLAUDE.md).
"""
import argparse, json, os, sqlite3
from collections import defaultdict

DEFAULT_DB = os.path.expanduser("~/Library/Application Support/dev.minorityreport.app/events.sqlite")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("MR_DATA_DIR") and os.path.join(os.environ["MR_DATA_DIR"], "events.sqlite") or DEFAULT_DB)
    ap.add_argument("--last", type=int, default=20)
    a = ap.parse_args()
    db = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    rows = db.execute(
        "select session_id, payload from events where kind = 'sidecar.sdk' and json_extract(payload, '$.message.type') in ('assistant', 'result') order by id"
    )
    s = defaultdict(lambda: {"prefix": None, "fresh": 0, "write": 0, "read": 0, "out": 0, "usd": 0.0, "turns": 0, "calls": set(), "models": set()})
    seen = set()
    for sid, p in rows:
        m = json.loads(p)["message"]
        r = s[sid]
        if m["type"] == "assistant":
            u = m.get("message", {}).get("usage") or {}
            mid = m.get("message", {}).get("id")
            if mid and u:
                r["calls"].add(mid)
            if r["prefix"] is None and u:
                r["prefix"] = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
            continue
        if m.get("uuid") in seen:
            continue
        seen.add(m.get("uuid"))
        r["turns"] += 1
        for name, mu in (m.get("modelUsage") or {}).items():
            r["fresh"] += mu.get("inputTokens", 0)
            r["write"] += mu.get("cacheCreationInputTokens", 0)
            r["read"] += mu.get("cacheReadInputTokens", 0)
            r["out"] += mu.get("outputTokens", 0)
            r["usd"] += mu.get("costUSD", 0.0)
            r["models"].add(name.split("[")[0].replace("claude-", ""))
    # How much of all input is the fixed prefix re-read on every API call: what trimming it can save.
    share = lambda v: min(1.0, (v["prefix"] or 0) * len(v["calls"]) / max(1, v["fresh"] + v["write"] + v["read"]))
    done = [(k, v) for k, v in s.items() if v["turns"]]
    k = lambda n: f"{n / 1000:.1f}k"
    print(f"{'session':<28}{'turns':>6}{'prefix':>9}{'fresh':>9}{'c.write':>10}{'c.read':>10}{'out':>9}{'list $':>9}{'calls':>7}{'prefix%':>8}  models")
    for sid, v in done[-a.last:]:
        print(f"{sid or '-':<28}{v['turns']:>6}{k(v['prefix'] or 0):>9}{k(v['fresh']):>9}{k(v['write']):>10}{k(v['read']):>10}{k(v['out']):>9}{v['usd']:>9.2f}{len(v['calls']):>7}{share(v):>8.0%}  {','.join(sorted(v['models']))}")
    t = {f: sum(v[f] for _, v in done) for f in ("fresh", "write", "read", "out", "usd", "turns")}
    pre = sorted(v["prefix"] for _, v in done if v["prefix"])
    tot_in = t["fresh"] + t["write"] + t["read"]
    print(f"\n{len(done)} sessions, {t['turns']} turns, list price ${t['usd']:.2f}")
    if pre:
        print(f"prefix per session: median {k(pre[len(pre) // 2])}, max {k(pre[-1])}")
    if tot_in:
        print(f"prefix share of all input: {sum((v['prefix'] or 0) * len(v['calls']) for _, v in done) / tot_in:.0%}")
        print(f"input mix: {t['read'] / tot_in:.0%} cache reads, {t['write'] / tot_in:.0%} cache writes, {t['fresh'] / tot_in:.0%} uncached; output {k(t['out'])}")


main()
