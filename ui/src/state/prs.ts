import { useEffect, useState } from "react";
import { cloneWorkspaces, prHere } from "../picker/autoReview";
import { prRepo, prSlug } from "./prRepo";
import { api, type Pr } from "./store";
import type { AppState } from "./types";

// The wall's GitHub lists, shared with auto-review (MR-72) through the "prs" cache entry.
export const PRS_TTL = 5 * 60_000;
export const startCwd = () => { try { return localStorage.getItem("mr.cwd") ?? "~/"; } catch { return "~/"; } };
export const loadPrs = (cwd: string): Promise<{ review: Pr[]; mine: Pr[] }> => Promise.allSettled([api.prs(cwd, "review"), api.prs(cwd, "address")])
  .then(([r, m]) => ({ review: r.status === "fulfilled" ? r.value : [], mine: m.status === "fulfilled" ? m.value : [] }));

export const prRepoSlug = (p: Pr) => p.repository?.nameWithOwner ?? prSlug(p.url);

/** Each PR repo's clone on this Mac (null: none found; missing: still looking). */
export function usePrClones(prs: Pr[]): Record<string, string | null> {
  const [clones, setClones] = useState<Record<string, string | null>>({});
  const slugs = [...new Set(prs.map(prRepoSlug).filter((s): s is string => !!s))];
  const key = slugs.sort().join(" ");
  useEffect(() => {
    let alive = true;
    for (const s of key.split(" ").filter(Boolean)) {
      if (s in clones) continue;
      void prRepo(s).then((path) => { if (alive) setClones((c) => ({ ...c, [s]: path })); });
    }
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return clones;
}

/** Whether a PR belongs on this workspace's wall: its clone's workspaces only, or every wall when
 *  no workspace works in it yet. Hidden while its clone is still being looked up. */
export function prInWorkspace(p: Pr, clones: Record<string, string | null>, all: Pick<AppState, "sessions" | "order" | "workspaces">, workspace: string): boolean {
  const slug = prRepoSlug(p);
  if (!slug) return true;
  if (!(slug in clones)) return false;
  const clone = clones[slug];
  return prHere(clone ? cloneWorkspaces(all, clone) : [], workspace);
}

// Watched repos (MR-170): every open PR in each that isn't mine and that I haven't reviewed, or that
// changed since my review (gh_prs "review" with a repo). A repo that fails to load adds nothing.
export const loadWatched = (cwd: string, repos: string[]): Promise<Pr[]> => Promise.allSettled(repos.map((r) => api.prs(cwd, "review", r)))
  .then((rs) => rs.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
export const watchedKey = (repos: string[]) => `prs.watched:${repos.join(",")}`;

/** What auto-review looks at: PRs that request my review, then the watched repos' PRs, once per URL.
 *  Watched PRs from a repo no longer in `repos` are dropped (the cache may predate a removal). */
export function mergeReviewPrs(requested: Pr[], watched: Pr[], repos: string[]): Pr[] {
  const keep = new Set(repos.map((r) => r.toLowerCase()));
  const seen = new Set<string>();
  const inRepo = (p: Pr) => keep.has((prRepoSlug(p) ?? "").toLowerCase());
  return [...requested, ...watched.filter(inRepo)].filter((p) => !seen.has(p.url) && !!seen.add(p.url));
}
