/**
 * simulator.ts — scripted incoming targets for the demo (PLAN.md §5.2).
 *
 * A GCS operator picks a threat, an origin on the map, a target from the
 * location table and a time-to-impact; this drives the track from here so it
 * keeps flowing whatever the browser does. Each tick sends one `track.update`
 * through a local node (1 Hz on the wire — renderers interpolate). Movement is
 * a straight great-circle-ish line with a per-threat pattern: missile straight
 * and fast, aircraft a gentle S, swarm a weave. When the track is neutralised
 * (seen in the merged lifecycle) updates stop; when it reaches the target
 * while still live, it reports `track.impact`; cancelling sends `track.lost`.
 * At most MAX_LIVE tracks per device.
 *
 * Late joiners: every REANNOUNCE_MS the original `track.detected` message is
 * re-flooded with its own id. Nodes that already hold the track drop it; a
 * node that booted (or a device that reconnected) mid-track gets it and
 * replays the position updates it had queued. This stands in for the
 * `track.snapshot` message PLAN.md §5.2 describes.
 */
import type { SimTrackInfo, ThreatType, TrackView } from "./types.js";

export const MAX_LIVE = 3;
const TICK_MS = 1_000;
export const REANNOUNCE_MS = 15_000; // re-flood the detection this often while the track is live
const ARRIVE_M = 150; // within this of the target counts as impact

export interface SimSpec {
  threat: ThreatType;
  origin: { lat: number; lng: number };
  target: { id: string; lat: number; lng: number };
  etaMs: number;
  station?: string;
  note?: string;
}

interface SimTrack extends SimTrackInfo {
  spec: SimSpec;
  timer: ReturnType<typeof setInterval>;
}

type Send = (kind: string, body: Record<string, unknown>, station?: string) => Promise<{ id?: string } | null>;
type Resend = (id: string) => Promise<boolean>;

const R = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
/** Point at fraction f (0..1) of the straight line origin→target, offset sideways by `lateralM` metres. */
function pointAt(o: { lat: number; lng: number }, t: { lat: number; lng: number }, f: number, lateralM: number) {
  const lat = o.lat + (t.lat - o.lat) * f;
  const lng = o.lng + (t.lng - o.lng) * f;
  const brg = toRad(bearingDeg(o, t) + 90); // perpendicular
  const dLat = (lateralM * Math.cos(brg)) / R;
  const dLng = (lateralM * Math.sin(brg)) / (R * Math.cos(toRad(lat)));
  return { lat: lat + toDeg(dLat), lng: lng + toDeg(dLng) };
}
/** Per-threat sideways pattern in metres at elapsed time (s). */
function lateral(threat: ThreatType, elapsedS: number, f: number): number {
  const fade = Math.sin(Math.PI * f); // zero at both ends so the track starts at the origin and ends on the target
  switch (threat) {
    case "swarm": return 350 * Math.sin(elapsedS / 3) * fade;
    case "aircraft": return 900 * Math.sin(elapsedS / 12) * fade;
    default: return 0;
  }
}

export class Simulator {
  private live = new Map<string, SimTrack>();

  constructor(
    private readonly send: Send,
    private readonly tracks: () => TrackView[],
    private readonly log: (line: string) => void,
    private readonly resend: Resend = async () => false,
  ) {}

  list(): SimTrackInfo[] {
    return [...this.live.values()].map(({ spec: _s, timer: _t, ...info }) => info);
  }

  async start(spec: SimSpec): Promise<SimTrackInfo> {
    if (this.live.size >= MAX_LIVE) throw new Error(`at most ${MAX_LIVE} simulated tracks at a time — cancel one first`);
    if (spec.threat === "emp") throw new Error("EMP is an area event (use the EMP signal button); it has no trajectory");
    const dist = distanceM(spec.origin, spec.target);
    const speed = dist / (spec.etaMs / 1000);
    const detected = await this.send("track.detected", {
      threat: spec.threat, note: spec.note, target: spec.target.id,
      pos: spec.origin, speed, heading: bearingDeg(spec.origin, spec.target), eta: spec.etaMs,
    }, spec.station);
    if (!detected?.id) throw new Error("no live node to launch the track through");
    const info: SimTrackInfo = { trackId: detected.id, threat: spec.threat, target: spec.target.id, etaMs: spec.etaMs, startedAt: Date.now(), seq: 0 };
    const sim: SimTrack = { ...info, spec, timer: setInterval(() => void this.tick(detected.id!), TICK_MS) };
    this.live.set(info.trackId, sim);
    this.log(`launched simulated ${spec.threat} ${info.trackId} → ${spec.target.id}, ${Math.round(dist / 1000)} km in ${Math.round(spec.etaMs / 1000)} s (${Math.round(speed * 3.6)} km/h)`);
    return info;
  }

  async cancel(trackId: string, reason = "cancelled by operator"): Promise<boolean> {
    const sim = this.live.get(trackId);
    if (!sim) return false;
    this.stop(trackId);
    await this.send("track.lost", { trackId, note: reason }, sim.spec.station);
    this.log(`simulated track ${trackId} cancelled`);
    return true;
  }

  private stop(trackId: string): void {
    const sim = this.live.get(trackId);
    if (!sim) return;
    clearInterval(sim.timer);
    this.live.delete(trackId);
  }

  private async tick(trackId: string): Promise<void> {
    const sim = this.live.get(trackId);
    if (!sim) return;
    // Stop when the mesh says the target is no longer live (neutralised / lost / impact).
    const view = this.tracks().find((t) => t.trackId === trackId);
    if (view && view.state !== "detected" && view.state !== "engaging") {
      this.stop(trackId);
      this.log(`simulated track ${trackId} stopped: ${view.state}`);
      return;
    }
    const { spec } = sim;
    const elapsed = Date.now() - sim.startedAt;
    const f = Math.min(1, elapsed / spec.etaMs);
    const pos = pointAt(spec.origin, spec.target, f, lateral(spec.threat, elapsed / 1000, f));
    const remaining = distanceM(pos, spec.target);
    sim.seq++;
    if (f >= 1 || remaining < ARRIVE_M) {
      this.stop(trackId);
      await this.send("track.impact", { trackId, lat: spec.target.lat, lng: spec.target.lng, seq: sim.seq }, spec.station);
      this.log(`simulated ${spec.threat} ${trackId} reached ${spec.target.id} — IMPACT`);
      return;
    }
    if (sim.seq % (REANNOUNCE_MS / TICK_MS) === 0) void this.resend(trackId); // for nodes that joined after the launch
    const dist = distanceM(spec.origin, spec.target);
    await this.send("track.update", {
      trackId, seq: sim.seq, t: Date.now(), lat: pos.lat, lng: pos.lng,
      heading: bearingDeg(pos, spec.target), speed: dist / (spec.etaMs / 1000), eta: Math.max(0, spec.etaMs - elapsed),
    }, spec.station);
  }
}
