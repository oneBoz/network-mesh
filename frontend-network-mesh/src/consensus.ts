import type { MeshState, NodeStatus } from "./types";

const RANK: Record<NodeStatus, number> = { alive: 0, suspect: 1, dead: 2 };

/**
 * What the mesh as a whole believes about a node: majority opinion across all
 * reachable observers (ties broken pessimistically). This is belief, not ground
 * truth — the gap between the two right after a crash IS the SWIM detection
 * window, and the UI deliberately shows it.
 */
export function consensus(state: MeshState, subjectId: string): NodeStatus | "unknown" {
  const votes: Record<NodeStatus, number> = { alive: 0, suspect: 0, dead: 0 };
  let total = 0;
  for (const v of state.views) {
    if (!v.reachable) continue;
    const entry = v.id === subjectId ? { status: "alive" as NodeStatus } : v.view[subjectId];
    if (!entry) continue;
    votes[entry.status]++;
    total++;
  }
  if (!total) return "unknown";
  return (Object.keys(votes) as NodeStatus[]).reduce((best, s) =>
    votes[s] > votes[best] || (votes[s] === votes[best] && RANK[s] > RANK[best]) ? s : best
  );
}
