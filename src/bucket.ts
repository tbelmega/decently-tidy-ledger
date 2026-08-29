import type { ItemFile } from "decently-coordinated-loops/tools/types.ts";

/** A depends-on target is satisfied when its work is on `origin/master`. With an
 * explicit `merged` state this is exactly the states at/after the merge: merged,
 * tested, delivered, accepted (README §"Dependencies & readiness"). `implemented`
 * (PR filed, not merged) and `dropped` (abandoned) are deliberately NOT satisfied. */
export const MERGED_STATES = new Set(["merged", "tested", "delivered", "accepted"]);

export function makePriorityCompare(
  priorityProjects: readonly string[],
): (a: ItemFile, b: ItemFile) => number {
  const ranks = new Map(priorityProjects.map((project, index) => [project, index]));
  return (a, b) => {
    const rankA = ranks.get(a.project) ?? priorityProjects.length;
    const rankB = ranks.get(b.project) ?? priorityProjects.length;
    if (rankA !== rankB) return rankA - rankB;
    const byUpdated = b.updated.localeCompare(a.updated);
    return byUpdated || a.slug.localeCompare(b.slug);
  };
}

/** The ledger shows the blocked marker on every column, so this is exported rather
 * than kept private to the (now deleted) bucketing pass it was written for. */
export function unsatisfiedDependsOn(item: ItemFile, bySlug: Map<string, ItemFile>): string[] {
  return item.dependsOn.filter((target) => {
    const t = bySlug.get(target);
    if (!t) return true; // missing target file: treated as unsatisfied
    return !MERGED_STATES.has(t.state);
  });
}
