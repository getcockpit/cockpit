import { invoke } from "@tauri-apps/api/core";

// Where a PR's repo lives on this Mac (MR-48): /review and /pr-address must run in the PR's own
// clone, never in whatever folder was last picked. Answers you give are remembered per repo.
const KEY = "mr.prRepos";
const remembered = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };

/** `owner/name` from a PR URL or "owner/name#n"; null for a bare number. */
export function prSlug(spec: string): string | null {
  const m = spec.trim().replace(/^https?:\/\//, "").replace(/^github\.com\//, "").match(/^([\w.-]+)\/([\w.-]+)/);
  return m && !/^\d+$/.test(m[1]) ? `${m[1]}/${m[2]}` : null;
}

/** `owner/name` from what was typed (a repo URL works too), checked like the core's safe_slug; null if it isn't one. */
export function watchSlug(input: string): string | null {
  const s = input.trim().replace(/^https?:\/\//, "").replace(/^github\.com\//, "").replace(/\/$/, "").replace(/\.git$/, "");
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

export function rememberPrRepo(slug: string, path: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...remembered(), [slug]: path })); } catch { /* convenience only */ }
}

/** The clone's folder, or null when it can't be found (the caller then asks once). */
export async function prRepo(slug: string): Promise<string | null> {
  const known = remembered()[slug];
  if (known) return known;
  const found = await invoke<string | null>("pr_repo", { spec: slug }).catch(() => null);
  if (found) rememberPrRepo(slug, found);
  return found;
}
