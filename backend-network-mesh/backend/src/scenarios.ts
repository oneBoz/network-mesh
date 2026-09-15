/**
 * scenarios.ts — scripted demo content (PLAN.md §5.2 "scripted scenarios", G4).
 *
 * Two things live here:
 *
 * 1. The default Singapore layout: named defended assets at their real
 *    positions and a few spread-out slots for devices. `POST /api/geo/seed`
 *    fills in whatever the location table is missing, so a fresh machine has
 *    something to attack and defend within one click.
 *
 * 2. Attack scenarios. A scenario is a list of launches relative to ONE
 *    target: each step says when (delay after start), what (threat), from
 *    where (bearing and range from the target) and how long until impact.
 *    The operator picks the target — any asset or device on the map — and the
 *    origin is computed, so the same script works whichever asset is being
 *    defended. Everything downstream (matchmaking, escalation, neutralise) is
 *    the ordinary lifecycle; a scenario is just a repeatable way to start it.
 */
import type { GeoEntry, GeoTable, ScenarioInfo, ScenarioRun } from "./types.js";
import type { Simulator } from "./simulator.js";

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: "cruise-north",
    name: "Cruise missile from the north",
    description: "One fast missile 40 km out, 60 s to impact. The simplest end-to-end story: detected → responsible GCS → NEUTRALISED, or IMPACT if nobody acts.",
    steps: [{ delayMs: 0, threat: "missile", bearing: 350, rangeKm: 40, etaMs: 60_000 }],
  },
  {
    id: "two-swarms-se",
    name: "Two swarms from the south-east",
    description: "Two drone swarms 10 s apart on slightly different bearings, about two minutes to impact. Two concurrent tracks, two fallback chains, the swarm weave on the map.",
    steps: [
      { delayMs: 0, threat: "swarm", bearing: 135, rangeKm: 25, etaMs: 120_000 },
      { delayMs: 10_000, threat: "swarm", bearing: 120, rangeKm: 22, etaMs: 110_000, note: "second wave" },
    ],
  },
  {
    id: "saturation",
    name: "Saturation attack",
    description: "Missile, then aircraft, then swarm from three directions within 20 s — three live tracks, the most one device drives at once. Watch responsibility spread across devices.",
    steps: [
      { delayMs: 0, threat: "missile", bearing: 20, rangeKm: 35, etaMs: 45_000 },
      { delayMs: 10_000, threat: "aircraft", bearing: 200, rangeKm: 60, etaMs: 90_000 },
      { delayMs: 20_000, threat: "swarm", bearing: 130, rangeKm: 20, etaMs: 120_000 },
    ],
  },
  {
    id: "probe-aircraft",
    name: "Aircraft probe from the west",
    description: "One slow aircraft 70 km out, 150 s to impact — long enough for the 60 s engage timeout to escalate to a fallback if the responsible GCS does nothing.",
    steps: [{ delayMs: 0, threat: "aircraft", bearing: 250, rangeKm: 70, etaMs: 150_000 }],
  },
];

const R = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** The point `distM` metres from `from` along `bearingDeg` (great circle). */
export function destination(from: { lat: number; lng: number }, bearingDeg: number, distM: number): { lat: number; lng: number } {
  const d = distM / R, brg = toRad(bearingDeg), lat1 = toRad(from.lat), lng1 = toRad(from.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lng2 = lng1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** Schedules a scenario's launches on the simulator. Each launch is an ordinary simulated track. */
export class ScenarioRunner {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(private readonly sim: Simulator, private readonly log: (line: string) => void) {}

  run(sc: ScenarioInfo, target: { id: string; lat: number; lng: number }, station?: string): ScenarioRun {
    const runId = `${sc.id}-${++this.seq}`;
    this.log(`scenario "${sc.name}" started against ${target.id}: ${sc.steps.length} launch${sc.steps.length === 1 ? "" : "es"} over ${Math.round((sc.steps.at(-1)?.delayMs ?? 0) / 1000)} s`);
    sc.steps.forEach((step, i) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const origin = destination(target, step.bearing, step.rangeKm * 1000);
        void this.sim.start({
          threat: step.threat, origin, target, etaMs: step.etaMs, station,
          note: `${sc.name} · launch ${i + 1}/${sc.steps.length}${step.note ? ` · ${step.note}` : ""}`,
        }).catch((err: Error) => this.log(`scenario "${sc.name}" launch ${i + 1} failed: ${err.message}`));
      }, step.delayMs);
      this.timers.add(timer);
    });
    return { runId, scenario: sc.id, target: target.id, launches: sc.steps.length, startedAt: Date.now() };
  }

  /** Drop launches that have not happened yet (stop-all). Returns how many were dropped. */
  cancelPending(): number {
    const n = this.timers.size;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    return n;
  }
}

/** Defended assets of the demo at their real positions. */
export const DEMO_ASSETS: Record<string, GeoEntry> = {
  "asset-changi-airbase": { kind: "asset", lat: 1.3440, lng: 104.0060, label: "Changi Airbase" },
  "asset-paya-lebar-airbase": { kind: "asset", lat: 1.3604, lng: 103.9096, label: "Paya Lebar Airbase" },
  "asset-tuas-port": { kind: "asset", lat: 1.2500, lng: 103.6300, label: "Tuas Port" },
  "asset-jurong-island": { kind: "asset", lat: 1.2650, lng: 103.6950, label: "Jurong Island" },
  "asset-sembawang": { kind: "asset", lat: 1.4640, lng: 103.8330, label: "Sembawang Naval Base" },
  "asset-marina-bay": { kind: "asset", lat: 1.2830, lng: 103.8600, label: "Marina Bay" },
};

/** Where devices go when nobody has placed them: this device first, then remotes, spread across the island. */
export const DEMO_DEVICE_SLOTS: [number, number][] = [
  [1.3000, 103.8000], // Bukit Merah
  [1.3521, 103.9440], // Tampines
  [1.4300, 103.7900], // Woodlands
  [1.3400, 103.7000], // Jurong West
  [1.3800, 103.8500], // Ang Mo Kio
];

/** The entries a seed would add to `table`: every missing demo asset (by id, and by label — a
 *  hand-placed "Changi Airbase" must not get a twin), plus each unplaced device at a free slot. */
export function seedEntries(table: GeoTable, devices: string[]): Record<string, GeoEntry> {
  const out: Record<string, GeoEntry> = {};
  const labels = new Set(Object.values(table.entries).map((e) => (e.label ?? "").trim().toLowerCase()).filter(Boolean));
  for (const [id, e] of Object.entries(DEMO_ASSETS)) if (!table.entries[id] && !labels.has(e.label!.toLowerCase())) out[id] = e;
  const taken = new Set(Object.values(table.entries).map((e) => `${e.lat},${e.lng}`));
  let slot = 0;
  for (const device of devices) {
    if (!device || table.entries[device]) continue;
    while (slot < DEMO_DEVICE_SLOTS.length && taken.has(DEMO_DEVICE_SLOTS[slot].join(","))) slot++;
    if (slot >= DEMO_DEVICE_SLOTS.length) break;
    const [lat, lng] = DEMO_DEVICE_SLOTS[slot++];
    out[device] = { kind: "device", lat, lng };
  }
  return out;
}
