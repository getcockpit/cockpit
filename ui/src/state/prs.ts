import { api, type Pr } from "./store";

// The wall's GitHub lists, shared with auto-review (MR-72) through the "prs" cache entry.
export const PRS_TTL = 5 * 60_000;
export const startCwd = () => { try { return localStorage.getItem("mr.cwd") ?? "~/"; } catch { return "~/"; } };
export const loadPrs = (cwd: string): Promise<{ review: Pr[]; mine: Pr[] }> => Promise.allSettled([api.prs(cwd, "review"), api.prs(cwd, "address")])
  .then(([r, m]) => ({ review: r.status === "fulfilled" ? r.value : [], mine: m.status === "fulfilled" ? m.value : [] }));
