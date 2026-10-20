import type { SessionState } from "./types";

/** The Wall's spawn groups (MR-179): a session and the running sessions it spawned, as one block,
 *  like a doc group. Children of a session in a doc group join that group (`childrenOf`); the rest
 *  form a family whose parent tile comes first when it's running. Sessions in neither stay loose. */
export function groupSpawned(loose: string[], docGrouped: string[], sessions: Record<string, SessionState>): { families: { parent: string; running: boolean; children: string[] }[]; childrenOf: Map<string, string[]>; loose: string[] } {
  const inDoc = new Set(docGrouped);
  const isLoose = new Set(loose);
  const childrenOf = new Map<string, string[]>();
  const fam = new Map<string, string[]>();
  for (const id of loose) {
    const parent = sessions[id]?.spawnedBy?.id;
    if (!parent) continue;
    const into = inDoc.has(parent) ? childrenOf : fam;
    into.set(parent, [...(into.get(parent) ?? []), id]);
  }
  const placed = new Set([...fam.keys(), ...[...fam.values(), ...childrenOf.values()].flat()]);
  // Each family where its first member stands in the loose order, so the grid doesn't jump.
  const seen = new Set<string>();
  const families: { parent: string; running: boolean; children: string[] }[] = [];
  for (const id of loose) {
    const parent = fam.has(id) ? id : sessions[id]?.spawnedBy?.id;
    if (!parent || !fam.has(parent) || seen.has(parent)) continue;
    seen.add(parent);
    families.push({ parent, running: isLoose.has(parent), children: fam.get(parent)! });
  }
  return { families, childrenOf, loose: loose.filter((id) => !placed.has(id)) };
}
