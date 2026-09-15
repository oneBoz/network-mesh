/**
 * engagement.ts — the replicated engagement lifecycle (PLAN.md §5.3).
 *
 * A pure reducer over the data-channel message log plus a snapshot of
 * membership. Every node runs it over the same messages with (nearly) the same
 * membership, so every device shows the same state for every target, the same
 * way deterministic matchmaking gives every node the same assignment. No I/O,
 * no clocks of its own: `now` and membership come in through the context, so
 * the whole thing is testable with a fake timeline.
 *
 *   detected ──► engaging ──► neutralised
 *      │  ▲          │
 *      │  └──────────┘ (escalated: responsibility moves down the fallback chain
 *      │                when the responsible node dies, the engage timeout
 *      │                passes, or its GCS hands over)
 *      ├──► lost (track updates stopped)
 *      └──► impact (the target reached what it was aimed at — the defence leaked)
 *
 * Detection = `gcs.signal` or `track.detected` (same semantics: the ingesting
 * node's matchmaking assignment is the chain of responsibility, primary first).
 * Only the device that runs the currently responsible node may neutralise;
 * other attempts are recorded as rejected. Messages that arrive before their
 * `detected` (floods take different paths) are queued and replayed in order.
 */
import type { MeshMessage, ThreatType } from "./protocol.js";

export type TrackState = "detected" | "engaging" | "neutralised" | "lost" | "impact";
export type EscalationReason = "dead" | "timeout" | "handover";

export interface TrackPosition {
  seq: number; t: number; lat: number; lng: number;
  alt?: number; heading?: number; speed?: number; eta?: number;
}

export interface Escalation {
  at: number;
  from?: string; // node id that was responsible
  to?: string; // node id now responsible (undefined = nobody left: leaked)
  reason: EscalationReason;
  note?: string;
}

export interface Track {
  trackId: string;
  threat: ThreatType;
  detectedAt: number; // sender's clock (message `at`)
  origin: { node: string; device?: string; station?: string };
  note?: string;
  target?: string; // id in the location table the threat is heading for (device or asset)
  /** Ranked node ids, primary first — the chain of responsibility. */
  chain: string[];
  responsibleIndex: number; // index into chain; -1 = nobody (no coverage)
  responsibleSince: number; // receiver clock, for the engage timeout
  state: TrackState;
  escalations: Escalation[];
  engagingAt?: number; // the responsible GCS acknowledged
  neutralised?: { at: number; node: string; device?: string; station?: string; override?: boolean };
  rejected: { at: number; node: string; device?: string; action: string; reason: string }[];
  positions: TrackPosition[]; // G2: trajectory (capped)
  lastUpdateAt?: number; // receiver clock of the last position
  lostAt?: number;
  impactAt?: number;
}

export interface EngagementContext {
  now: number; // receiver clock
  deviceOf: (nodeId: string) => string | undefined; // from membership (self included)
  isAlive: (nodeId: string) => boolean; // from membership (self counts as alive)
  engageTimeoutMs: (threat: ThreatType) => number;
  lostAfterMs: number; // no position update for this long ⇒ lost (tracks with positions only)
}

export interface EngagementState {
  tracks: Map<string, Track>;
  /** Lifecycle messages whose `detected` has not arrived yet, per track. */
  pending: Map<string, MeshMessage[]>;
}

export const MAX_POSITIONS = 120;
const MAX_TRACKS = 50;
const MAX_PENDING = 200;

export const DEFAULT_ENGAGE_TIMEOUT_MS: Record<ThreatType, number> = {
  missile: 45_000, swarm: 60_000, aircraft: 60_000, emp: 30_000,
};
export const DEFAULT_LOST_AFTER_MS = 15_000;

export function createEngagement(): EngagementState {
  return { tracks: new Map(), pending: new Map() };
}

export const LIFECYCLE_KINDS = new Set([
  "gcs.signal", "track.detected", "track.update", "track.engaging", "track.handover", "track.neutralised", "track.lost", "track.impact",
]);
export const isDetection = (kind: string) => kind === "gcs.signal" || kind === "track.detected";

const trackIdOf = (m: MeshMessage): string | undefined =>
  isDetection(m.kind) ? m.id : (typeof m.body.trackId === "string" && m.body.trackId ? m.body.trackId : undefined);

export function responsibleNode(t: Track): string | undefined {
  return t.responsibleIndex >= 0 ? t.chain[t.responsibleIndex] : undefined;
}

export function responsibleDevice(t: Track, ctx: Pick<EngagementContext, "deviceOf">): string | undefined {
  const n = responsibleNode(t);
  return n ? ctx.deviceOf(n) : undefined;
}

export const isLive = (t: Track) => t.state === "detected" || t.state === "engaging";

/**
 * Apply one data-channel message. `chain` must be given for detections (the
 * ingesting node's ranked assignment: primary, then fallbacks). Returns the
 * affected track, or undefined if the message was irrelevant or queued.
 */
export function applyMessage(st: EngagementState, m: MeshMessage, ctx: EngagementContext, chain?: string[]): Track | undefined {
  if (!LIFECYCLE_KINDS.has(m.kind)) return undefined;
  const id = trackIdOf(m);
  if (!id) return undefined;

  if (isDetection(m.kind)) {
    if (st.tracks.has(id)) return st.tracks.get(id); // duplicate detection (dedupe is upstream, but be safe)
    const threat = m.body.threat as ThreatType;
    const ranked = chain ?? [];
    const t: Track = {
      trackId: id, threat, detectedAt: m.at,
      origin: { node: m.from.node, device: m.from.device, station: m.from.station },
      note: typeof m.body.note === "string" ? m.body.note : undefined,
      target: typeof m.body.target === "string" ? m.body.target : undefined,
      chain: ranked, responsibleIndex: ranked.length ? 0 : -1, responsibleSince: ctx.now,
      state: "detected", escalations: [], rejected: [], positions: [],
    };
    const pos = m.body.pos as { lat?: number; lng?: number } | undefined;
    if (pos && typeof pos.lat === "number" && typeof pos.lng === "number") {
      t.positions.push({ seq: 0, t: m.at, lat: pos.lat, lng: pos.lng });
      t.lastUpdateAt = ctx.now;
    }
    st.tracks.set(id, t);
    if (st.tracks.size > MAX_TRACKS) {
      // Forget the oldest finished track first, then the oldest of all.
      const victims = [...st.tracks.values()].sort((a, b) => Number(isLive(a)) - Number(isLive(b)) || a.detectedAt - b.detectedAt);
      st.tracks.delete(victims[0].trackId);
    }
    // Replay anything that arrived early, in sender-time order.
    const queued = st.pending.get(id);
    if (queued) {
      st.pending.delete(id);
      for (const q of queued.sort((a, b) => a.at - b.at)) applyMessage(st, q, ctx);
    }
    return t;
  }

  const t = st.tracks.get(id);
  if (!t) {
    const q = st.pending.get(id) ?? [];
    if (q.length < MAX_PENDING) q.push(m);
    st.pending.set(id, q);
    return undefined;
  }

  switch (m.kind) {
    case "track.update": {
      if (!isLive(t)) return t;
      const b = m.body as Partial<TrackPosition>;
      if (typeof b.seq !== "number" || typeof b.lat !== "number" || typeof b.lng !== "number") return t;
      const last = t.positions.at(-1);
      if (last && b.seq <= last.seq) return t; // stale or duplicate
      t.positions.push({ seq: b.seq, t: typeof b.t === "number" ? b.t : m.at, lat: b.lat, lng: b.lng, alt: b.alt, heading: b.heading, speed: b.speed, eta: b.eta });
      if (t.positions.length > MAX_POSITIONS) t.positions.splice(0, t.positions.length - MAX_POSITIONS);
      t.lastUpdateAt = ctx.now;
      return t;
    }
    case "track.engaging": {
      if (!isLive(t)) return t;
      if (!authorised(t, m, ctx)) { reject(t, m, ctx, "not the responsible device"); return t; }
      t.state = "engaging";
      t.engagingAt = t.engagingAt ?? ctx.now;
      return t;
    }
    case "track.handover": {
      if (!isLive(t)) return t;
      if (!authorised(t, m, ctx)) { reject(t, m, ctx, "not the responsible device"); return t; }
      advance(t, "handover", ctx, typeof m.body.note === "string" ? m.body.note : undefined);
      return t;
    }
    case "track.neutralised": {
      if (t.state === "neutralised") return t;
      if (!isLive(t)) { reject(t, m, ctx, `track already ${t.state}`); return t; }
      const override = m.body.override === true;
      if (!override && !authorised(t, m, ctx)) { reject(t, m, ctx, "not the responsible device"); return t; }
      t.state = "neutralised";
      t.neutralised = { at: ctx.now, node: m.from.node, device: m.from.device, station: m.from.station, override: override || undefined };
      return t;
    }
    case "track.lost": {
      if (!isLive(t)) return t;
      t.state = "lost";
      t.lostAt = ctx.now;
      return t;
    }
    case "track.impact": {
      // The threat reached its target while still live: the defence leaked.
      // Only the track's origin (the simulator / sensor that owns it) may say so.
      if (!isLive(t)) return t;
      if (m.from.device !== t.origin.device) { reject(t, m, ctx, "only the track's origin may report impact"); return t; }
      t.state = "impact";
      t.impactAt = ctx.now;
      const b = m.body as Partial<TrackPosition>;
      if (typeof b.lat === "number" && typeof b.lng === "number") {
        const last = t.positions.at(-1);
        t.positions.push({ seq: (last?.seq ?? 0) + 1, t: m.at, lat: b.lat, lng: b.lng });
      }
      return t;
    }
  }
  return t;
}

/** Only the device running the currently responsible node may act on a track. */
function authorised(t: Track, m: MeshMessage, ctx: EngagementContext): boolean {
  const dev = responsibleDevice(t, ctx);
  return !!dev && !!m.from.device && dev === m.from.device;
}

function reject(t: Track, m: MeshMessage, ctx: EngagementContext, reason: string): void {
  t.rejected.push({ at: ctx.now, node: m.from.node, device: m.from.device, action: m.kind.replace("track.", ""), reason });
  if (t.rejected.length > 20) t.rejected.shift();
}

/** Move responsibility to the next alive node in the chain (or to nobody). */
function advance(t: Track, reason: EscalationReason, ctx: EngagementContext, note?: string): void {
  const from = responsibleNode(t);
  let next = -1;
  for (let i = t.responsibleIndex + 1; i < t.chain.length; i++) {
    if (ctx.isAlive(t.chain[i])) { next = i; break; }
  }
  t.responsibleIndex = next;
  t.responsibleSince = ctx.now;
  t.state = "detected"; // the new responsible GCS has not acknowledged yet
  t.engagingAt = undefined;
  t.escalations.push({ at: ctx.now, from, to: next >= 0 ? t.chain[next] : undefined, reason, note });
}

/**
 * Time- and membership-driven transitions. Call once per protocol period:
 * escalates when the responsible node is dead or the engage timeout passed,
 * marks a streamed track lost when its updates stop. Returns changed tracks.
 */
export function tick(st: EngagementState, ctx: EngagementContext): Track[] {
  const changed: Track[] = [];
  for (const t of st.tracks.values()) {
    if (!isLive(t)) continue;
    if (t.positions.length > 1 && t.lastUpdateAt !== undefined && ctx.now - t.lastUpdateAt > ctx.lostAfterMs) {
      t.state = "lost";
      t.lostAt = ctx.now;
      changed.push(t);
      continue;
    }
    const node = responsibleNode(t);
    if (node && !ctx.isAlive(node)) {
      advance(t, "dead", ctx);
      changed.push(t);
    } else if (node && ctx.now - t.responsibleSince > ctx.engageTimeoutMs(t.threat)) {
      advance(t, "timeout", ctx);
      changed.push(t);
    } else if (!node && t.responsibleIndex === -1 && t.chain.some((n) => ctx.isAlive(n))) {
      // Nobody was responsible (all dead at the time) but someone is alive again.
      t.responsibleIndex = t.chain.findIndex((n) => ctx.isAlive(n));
      t.responsibleSince = ctx.now;
      t.escalations.push({ at: ctx.now, to: t.chain[t.responsibleIndex], reason: "dead", note: "coverage restored" });
      changed.push(t);
    }
  }
  return changed;
}

/** Plain-object view for HTTP (Maps are not JSON). */
export function serialize(st: EngagementState): Track[] {
  return [...st.tracks.values()].sort((a, b) => b.detectedAt - a.detectedAt);
}
