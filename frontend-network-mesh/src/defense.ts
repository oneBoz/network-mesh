/**
 * Defense-system metadata for the demo fleet's server sites. Keyed by the
 * node id / service name the backend's bootDemo spawns — a node whose name
 * isn't in this map (hand-added servers) just renders without a layer tag.
 *
 * Display strings only. The numbers the mesh actually decides with (threat
 * coverage, layer priority, cost) live in backend-network-mesh/src/skills.ts.
 */
export interface DefenseSystem {
  /** Full display name. */
  name: string;
  /** Short label that fits inside a topology-graph node circle. */
  short: string;
  /** Which defense layer this system covers. */
  layer: string;
  /** What the system does. */
  role: string;
  leader?: string;
}

export const DEFENSE_SYSTEMS: Record<string, DefenseSystem> = {
  maelstrom: {
    name: "MAELSTROM Command",
    short: "MAEL",
    layer: "Defense Layer 1",
    role: "Anti-swarm — takes down higher-level threats using high-speed propulsion.",
  },
  aegis: {
    name: "AEGIS",
    short: "AEGIS",
    layer: "Defense Layer 2",
    role: "Good close-combat fighting capabilities.",
  },
  smartfalcon: {
    name: "SmartFalcon",
    short: "FALCON",
    layer: "Defense Layer 3",
    role: "Similar to AEGIS — if AEGIS fails, SmartFalcon is ready to take down.",
  },
  edgefuse: {
    name: "EdgeFuse",
    short: "EDGE",
    layer: "Defense Layer 4",
    role:
      "On-sensor fused detection for counter-swarm. If layers 2 and 3 fail, EdgeFuse goes for the kill.",
    leader: "Lee Jinho",
  },
  wisl: {
    name: "WISL",
    short: "WISL",
    layer: "EMP Defense",
    role:
      "Anti-swarm EMP jamming for e-warfare — jack of none, master of one. Economically smarter to send for EMF threats than Layer 1 missiles.",
  },
};

/** One-line tooltip text for a server site, or undefined if it's not a known system. */
export function defenseTooltip(id: string): string | undefined {
  const d = DEFENSE_SYSTEMS[id];
  if (!d) return undefined;
  return `${d.name} — ${d.layer}${d.leader ? ` (leader: ${d.leader})` : ""}\n${d.role}`;
}
