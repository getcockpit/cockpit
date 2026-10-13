#!/usr/bin/env python3
"""Token use per session, from the event log (no Claude usage).

  python3 -I scripts/token-usage.py [--db PATH] [--last N] [--window before|200k|limit|...]

prefix = input + cache tokens of a session's first API call: the fixed cost every session
pays before the user's first word (system prompt, tool schemas, skills list, CLAUDE.md).
window = the auto-compact window the session ran with (I63); "before" = started before it was recorded.
ctx/call = average input per API call, which a smaller window keeps down.
"""
import argparse, json, os, sqlite3
from collections import defaultdict

DEFAULT_DB = os.path.expanduser("~/Library/Application Support/dev.getcockpit.app/events.sqlite")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("MR_DATA_DIR") and os.path.join(os.environ["MR_DATA_DIR"], "events.sqlite") or DEFAULT_DB)
    ap.add_argument("--last", type=int, default=20)
    ap.add_argument("--window", help="only sessions with this compaction window, e.g. before, 200k, limit")
    a = ap.parse_args()
    db = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    rows = db.execute(
        "select session_id, payload from events where kind = 'sidecar.sdk' and json_extract(payload, '$.message.type') in ('assistant', 'result') order by id"
    )
    # The window each session last (re)started with; resumes record it again.
    win = {}
    for sid, w, t in db.execute("select session_id, json_extract(payload, '$.compact_window'), json_type(payload, '$.compact_window') from events where kind = 'ui.session_requested' order by id"):
        win[sid] = "before" if t is None else "limit" if t == "null" else f"{int(w) // 1000}k"
    s = defaultdict(lambda: {"prefix": None, "fresh": 0, "write": 0, "read": 0, "out": 0, "usd": 0.0, "turns": 0, "calls": {}, "models": set()})
    seen = set()
    # A result's modelUsage is the running total of its SDK run, not the turn's own use: count only
    # the growth since the last result, and start over when a new run (resume) resets it.
    last = {}
    fields = (("fresh", "inputTokens"), ("write", "cacheCreationInputTokens"), ("read", "cacheReadInputTokens"), ("out", "outputTokens"), ("usd", "costUSD"))
    for sid, p in rows:
        m = json.loads(p)["message"]
        r = s[sid]
        if m["type"] == "assistant":
            u = m.get("message", {}).get("usage") or {}
            mid = m.get("message", {}).get("id")
            if mid and u:
                # Input per API call, from the call itself: result totals miss interrupted turns.
                r["calls"][mid] = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
            if r["prefix"] is None and u:
                r["prefix"] = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0)
            continue
        if m.get("uuid") in seen:
            continue
        seen.add(m.get("uuid"))
        r["turns"] += 1
        for name, mu in (m.get("modelUsage") or {}).items():
            now = [mu.get(f, 0) for _, f in fields]
            prev = last.get((sid, name))
            if prev is None or any(n < p for n, p in zip(now, prev)):
                prev = [0] * len(fields)
            for (key, _), n, p in zip(fields, now, prev):
                r[key] += n - p
            last[(sid, name)] = now
            r["models"].add(name.split("[")[0].replace("claude-", ""))
    # How much of all input is the fixed prefix re-read on every API call: what trimming it can save.
    share = lambda v: min(1.0, (v["prefix"] or 0) * len(v["calls"]) / max(1, sum(v["calls"].values())))
    ins = lambda v: v["fresh"] + v["write"] + v["read"]
    ctx = lambda v: sum(v["calls"].values()) / max(1, len(v["calls"]))
    done = [(k, v) for k, v in s.items() if v["turns"] and (not a.window or win.get(k, "before") == a.window)]
    k = lambda n: f"{n / 1000:.1f}k"
    print(f"{'session':<28}{'turns':>6}{'prefix':>9}{'fresh':>9}{'c.write':>10}{'c.read':>10}{'out':>9}{'list $':>9}{'calls':>7}{'prefix%':>8}{'ctx/call':>9}{'window':>8}  models")
    for sid, v in done[-a.last:]:
        print(f"{sid or '-':<28}{v['turns']:>6}{k(v['prefix'] or 0):>9}{k(v['fresh']):>9}{k(v['write']):>10}{k(v['read']):>10}{k(v['out']):>9}{v['usd']:>9.2f}{len(v['calls']):>7}{share(v):>8.0%}{k(ctx(v)):>9}{win.get(sid, 'before'):>8}  {','.join(sorted(v['models']))}")
    t = {f: sum(v[f] for _, v in done) for f in ("fresh", "write", "read", "out", "usd", "turns")}
    pre = sorted(v["prefix"] for _, v in done if v["prefix"])
    tot_in = t["fresh"] + t["write"] + t["read"]
    print(f"\n{len(done)} sessions, {t['turns']} turns, list price ${t['usd']:.2f}")
    if pre:
        print(f"prefix per session: median {k(pre[len(pre) // 2])}, max {k(pre[-1])}")
    if tot_in:
        print(f"prefix share of all input: {sum((v['prefix'] or 0) * len(v['calls']) for _, v in done) / max(1, sum(sum(v['calls'].values()) for _, v in done)):.0%}")
        print(f"input mix: {t['read'] / tot_in:.0%} cache reads, {t['write'] / tot_in:.0%} cache writes, {t['fresh'] / tot_in:.0%} uncached; output {k(t['out'])}")
    # Before/after: the same numbers per compaction window, per turn so long and short sessions compare.
    groups = defaultdict(list)
    for sid, v in done:
        groups[win.get(sid, "before")].append(v)
    if len(groups) > 1 or a.window:
        print(f"\n{'window':<8}{'sessions':>9}{'turns':>7}{'ctx/call':>10}{'input/turn':>12}{'list $/turn':>13}")
        for w, vs in sorted(groups.items()):
            turns = sum(v["turns"] for v in vs)
            calls = sum(len(v["calls"]) for v in vs)
            tin = sum(ins(v) for v in vs)
            per_call = sum(sum(v["calls"].values()) for v in vs) / max(1, calls)
            print(f"{w:<8}{len(vs):>9}{turns:>7}{k(per_call):>10}{k(tin / max(1, turns)):>12}{sum(v['usd'] for v in vs) / max(1, turns):>13.2f}")
    # The Cockpit layer's own calls (decision 34): its overhead, on its own key, apart from Claude.
    rows = db.execute("SELECT json_extract(payload,'$.purpose'), count(*), sum(json_extract(payload,'$.input_tokens')), sum(json_extract(payload,'$.output_tokens')), sum(json_extract(payload,'$.cost_usd')), sum(json_extract(payload,'$.ok') = 0) FROM events WHERE kind = 'cockpit.usage' GROUP BY 1").fetchall()
    if rows:
        print(f"\nCockpit layer (own key){'':<4}{'calls':>7}{'in':>9}{'out':>9}{'list $':>9}{'failed':>8}")
        for purpose, n, i, o, usd, bad in rows:
            print(f"{purpose or '?':<27}{n:>7}{k(i or 0):>9}{k(o or 0):>9}{usd or 0:>9.2f}{bad or 0:>8}")


main()
