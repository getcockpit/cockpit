import { useEffect, useRef } from "react";
import { needsAutoReview, lastLocalReview, reviewKey, type ReviewState } from "../picker/autoReview";
import { promptFor } from "../screens/StartPicker";
import { cached } from "./cache";
import { prRepo, prSlug } from "./prRepo";
import { loadPrs, PRS_TTL, startCwd } from "./prs";
import { api, type Pr } from "./store";
import type { AppState } from "./types";

// Auto-review (MR-72): every minute, look at the PRs waiting for your review and start /review in
// the PR's clone for each one that needs it (see needsAutoReview). Runs on every screen.
const KEY = "mr.autoReviewed";
const started = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]")); } catch { return new Set(); } };
const markStarted = (k: string) => { try { localStorage.setItem(KEY, JSON.stringify([...started(), k].slice(-200))); } catch { /* the session itself also counts as a review */ } };

export function useAutoReview(state: AppState) {
  const live = useRef(state);
  live.current = state;
  useEffect(() => {
    if (!state.autoReview) return;
    let alive = true;
    const busy = new Set<string>();
    const checked = new Map<string, string>(); // url → updatedAt already decided: no gh call until it changes
    const run = async (prs: Pr[]) => {
      for (const p of prs) {
        if (!alive || !live.current.autoReview) return;
        if (p.isDraft || busy.has(p.url) || checked.get(p.url) === p.updatedAt) continue;
        busy.add(p.url);
        try {
          const info = await api.reviewState(p.url).catch(() => null) as ReviewState | null;
          if (!info) continue;
          if (!needsAutoReview(info, p.url, lastLocalReview(Object.values(live.current.sessions), p), started())) { checked.set(p.url, p.updatedAt); continue; }
          const slug = p.repository?.nameWithOwner ?? prSlug(p.url);
          const where = slug ? await prRepo(slug) : null;
          if (!where) { checked.set(p.url, p.updatedAt); continue; } // no clone found: it stays a suggestion on the wall
          const id = await api.start(where, promptFor("review", p.url), "review");
          markStarted(reviewKey(p.url, info.headSha));
          checked.set(p.url, p.updatedAt);
          void api.log("ui.auto_review_started", { url: p.url, head: info.headSha }, id);
          window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Started a review of PR #${p.number}: ${p.title}` }));
        } catch {
          return; // session cap reached or the start failed: try again on the next tick
        } finally {
          busy.delete(p.url);
        }
      }
    };
    const tick = () => {
      const now = cached("prs", PRS_TTL, () => loadPrs(startCwd()), (v) => { if (alive) void run(v.review); });
      if (now) void run(now.review);
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [state.autoReview]);
}
