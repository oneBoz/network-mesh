/**
 * skills.ts — the defense-system skill table and the matchmaking function.
 *
 * This is the mesh's brain, and it is deliberately a PURE function of the
 * local membership view: filter alive nodes whose skills cover the threat,
 * rank by layer → cost → id. The ordering is total, so every node with a
 * converged view computes the IDENTICAL assignment independently — the mesh
 * acts as one entity with no leader and no coordination round-trip.
 * Escalation is emergent: SWIM convicts the primary, the alive filter drops
 * it, and the next matchmake returns the fallback.
 *
 * (The frontend's defense.ts keeps the human-readable display strings; the
 * numbers here are the authority the mesh actually decides with.)
 */
import type { PeerInfo, Skills, ThreatEvent, ThreatType } from "./protocol.js";

export const THREAT_TYPES: ThreatType[] = ["missile", "swarm", "aircraft", "emp"];

/** Default skills keyed by SERVICE name (the demo fleet uses service === id).
 *  maelstrom doesn't cover "missile": Layer 1 is anti-swarm, which also keeps
 *  the aegis → smartfalcon → edgefuse escalation ladder demonstrable. */
export const SKILL_TABLE: Record<string, Skills> = {
  maelstrom:   { threats: ["swarm"],                          layer: 1, cost: 8 },
  aegis:       { threats: ["missile", "aircraft"],            layer: 2, cost: 5 },
  smartfalcon: { threats: ["missile", "aircraft"],            layer: 3, cost: 5 },
  edgefuse:    { threats: ["missile", "aircraft", "swarm"],   layer: 4, cost: 6 },
  wisl:        { threats: ["emp", "swarm"],                   layer: 5, cost: 2 },
};

export interface RankedCandidate {
  id: string;
  service?: string;
  layer: number;
  cost: number;
}

/** The mesh's answer to a threat — what /threat returns and every node logs. */
export interface Assignment {
  threatId: string;
  threat: ThreatType;
  primary?: string; // undefined => no alive node covers this threat
  fallbacks: string[];
  ranked: RankedCandidate[];
  computedBy: string; // node id that ran matchmake
  at: number;
}

/** Deterministic matchmaking: coverage filter, then layer asc → cost asc →
 *  id lexicographic. Total order ⇒ same output on every converged node. */
export function matchmake(threat: ThreatType, alivePool: PeerInfo[]): PeerInfo[] {
  return alivePool
    .filter((p) => p.skills?.threats?.includes(threat))
    .sort(
      (a, b) =>
        a.skills!.layer - b.skills!.layer ||
        a.skills!.cost - b.skills!.cost ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

export function toAssignment(event: ThreatEvent, ranked: PeerInfo[], selfId: string): Assignment {
  return {
    threatId: event.threatId,
    threat: event.threat,
    primary: ranked[0]?.id,
    fallbacks: ranked.slice(1).map((p) => p.id),
    ranked: ranked.map((p) => ({
      id: p.id, service: p.service, layer: p.skills!.layer, cost: p.skills!.cost,
    })),
    computedBy: selfId,
    at: Date.now(),
  };
}
