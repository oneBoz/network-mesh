import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeshMessage } from "../src/protocol.js";
import {
  applyMessage, createEngagement, tick, responsibleNode, responsibleDevice, isLive,
  DEFAULT_ENGAGE_TIMEOUT_MS, DEFAULT_LOST_AFTER_MS,
} from "../src/engagement.js";
import type { EngagementContext } from "../src/engagement.js";

// Two devices: "mac" runs aegis-mac & smartfalcon-mac; "vm" runs aegis-vm & edgefuse-vm.
const DEVICE: Record<string, string> = { "aegis-vm": "vm", "aegis-mac": "mac", "smartfalcon-mac": "mac", "edgefuse-vm": "vm" };
const CHAIN = ["aegis-vm", "aegis-mac", "smartfalcon-mac", "edgefuse-vm"];

function ctx(now: number, dead: string[] = []): EngagementContext {
  return {
    now, deviceOf: (n) => DEVICE[n], isAlive: (n) => n in DEVICE && !dead.includes(n),
    engageTimeoutMs: (t) => DEFAULT_ENGAGE_TIMEOUT_MS[t], lostAfterMs: DEFAULT_LOST_AFTER_MS,
  };
}
let n = 0;
const msg = (kind: string, from: { node: string; device: string; station?: string }, body: Record<string, unknown>, at: number, id?: string): MeshMessage =>
  ({ id: id ?? `m-${++n}`, at, kind, from, body });
const GCS_MAC = { node: "aegis-mac", device: "mac", station: "GCS-Alpha" };
const GCS_VM = { node: "aegis-vm", device: "vm", station: "GCS-Tokyo" };
const CMD = { node: "maelstrom-mac", device: "mac" };

test("detection creates a track with the primary's device responsible", () => {
  const st = createEngagement();
  const t = applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "missile" }, 1000, "t1"), ctx(1000), CHAIN)!;
  assert.equal(t.state, "detected");
  assert.equal(responsibleNode(t), "aegis-vm");
  assert.equal(responsibleDevice(t, ctx(1000)), "vm");
  assert.equal(t.chain.length, 4);
});

test("only the responsible device may neutralise; others are recorded as rejected", () => {
  const st = createEngagement();
  applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "missile" }, 1000, "t1"), ctx(1000), CHAIN);
  let t = applyMessage(st, msg("track.neutralised", GCS_MAC, { trackId: "t1" }, 2000), ctx(2000))!;
  assert.equal(t.state, "detected");
  assert.equal(t.rejected.length, 1);
  assert.equal(t.rejected[0].device, "mac");
  t = applyMessage(st, msg("track.neutralised", GCS_VM, { trackId: "t1" }, 3000), ctx(3000))!;
  assert.equal(t.state, "neutralised");
  assert.equal(t.neutralised?.device, "vm");
  assert.equal(t.neutralised?.station, "GCS-Tokyo");
});

test("Command override neutralises without being responsible, and is marked as such", () => {
  const st = createEngagement();
  applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "swarm" }, 1000, "t1"), ctx(1000), CHAIN);
  const t = applyMessage(st, msg("track.neutralised", CMD, { trackId: "t1", override: true }, 2000), ctx(2000))!;
  assert.equal(t.state, "neutralised");
  assert.equal(t.neutralised?.override, true);
});

test("a dead responsible node escalates to the next ALIVE fallback", () => {
  const st = createEngagement();
  applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "missile" }, 1000, "t1"), ctx(1000), CHAIN);
  const changed = tick(st, ctx(5000, ["aegis-vm", "aegis-mac"]));
  assert.equal(changed.length, 1);
  const t = st.tracks.get("t1")!;
  assert.equal(responsibleNode(t), "smartfalcon-mac"); // skipped the dead aegis-mac
  assert.equal(t.escalations[0].reason, "dead");
  assert.equal(t.escalations[0].from, "aegis-vm");
  assert.equal(responsibleDevice(t, ctx(5000)), "mac");
});

test("the engage timeout escalates; engaging resets nothing but the state", () => {
  const st = createEngagement();
  applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "missile" }, 1000, "t1"), ctx(1000), CHAIN);
  applyMessage(st, msg("track.engaging", GCS_VM, { trackId: "t1" }, 2000), ctx(2000));
  assert.equal(st.tracks.get("t1")!.state, "engaging");
  assert.equal(tick(st, ctx(1000 + DEFAULT_ENGAGE_TIMEOUT_MS.missile)).length, 0, "not yet");
  const changed = tick(st, ctx(1000 + DEFAULT_ENGAGE_TIMEOUT_MS.missile + 1));
  assert.equal(changed.length, 1);
  const t = st.tracks.get("t1")!;
  assert.equal(t.escalations[0].reason, "timeout");
  assert.equal(responsibleNode(t), "aegis-mac");
  assert.equal(t.state, "detected", "new responsible GCS has not acknowledged yet");
});

test("handover by the responsible device moves responsibility; by others is rejected", () => {
  const st = createEngagement();
  applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "aircraft" }, 1000, "t1"), ctx(1000), CHAIN);
  applyMessage(st, msg("track.handover", GCS_MAC, { trackId: "t1" }, 2000), ctx(2000));
  assert.equal(responsibleNode(st.tracks.get("t1")!), "aegis-vm", "mac was not responsible");
  assert.equal(st.tracks.get("t1")!.rejected.length, 1);
  applyMessage(st, msg("track.handover", GCS_VM, { trackId: "t1", note: "out of interceptors" }, 3000), ctx(3000));
  const t = st.tracks.get("t1")!;
  assert.equal(responsibleNode(t), "aegis-mac");
  assert.equal(t.escalations[0].reason, "handover");
  assert.equal(t.escalations[0].note, "out of interceptors");
});

test("when nobody in the chain is alive, responsibility is nobody, and returns when someone is back", () => {
  const st = createEngagement();
  applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "missile" }, 1000, "t1"), ctx(1000), CHAIN);
  tick(st, ctx(2000, CHAIN));
  const t = st.tracks.get("t1")!;
  assert.equal(responsibleNode(t), undefined);
  assert.equal(t.escalations.at(-1)!.to, undefined);
  tick(st, ctx(3000, ["aegis-vm"]));
  assert.equal(responsibleNode(t), "aegis-mac");
});

test("out-of-order: a neutralise that arrives before its detection is queued and applied after", () => {
  const st = createEngagement();
  assert.equal(applyMessage(st, msg("track.neutralised", GCS_VM, { trackId: "t1" }, 2000), ctx(2000)), undefined);
  assert.equal(st.pending.get("t1")?.length, 1);
  const t = applyMessage(st, msg("gcs.signal", GCS_MAC, { threat: "missile" }, 1000, "t1"), ctx(2100), CHAIN)!;
  assert.equal(t.state, "neutralised");
  assert.equal(st.pending.size, 0);
});

test("position updates are ordered by seq; a silent streamed track is lost", () => {
  const st = createEngagement();
  applyMessage(st, msg("track.detected", GCS_MAC, { threat: "missile", pos: { lat: 1.2, lng: 103.8 } }, 1000, "t1"), ctx(1000), CHAIN);
  applyMessage(st, msg("track.update", GCS_MAC, { trackId: "t1", seq: 2, lat: 1.22, lng: 103.82 }, 3000), ctx(3000));
  applyMessage(st, msg("track.update", GCS_MAC, { trackId: "t1", seq: 1, lat: 1.21, lng: 103.81 }, 2000), ctx(3100)); // late, stale
  const t = st.tracks.get("t1")!;
  assert.deepEqual(t.positions.map((p) => p.seq), [0, 2]);
  assert.equal(tick(st, ctx(3000 + DEFAULT_LOST_AFTER_MS)).length, 0);
  tick(st, ctx(3000 + DEFAULT_LOST_AFTER_MS + 1));
  assert.equal(t.state, "lost");
  assert.equal(isLive(t), false);
  // nothing may act on a lost track
  applyMessage(st, msg("track.neutralised", GCS_VM, { trackId: "t1" }, 9000), ctx(20000));
  assert.equal(t.state, "lost");
  assert.equal(t.rejected.at(-1)?.reason, "track already lost");
});

test("determinism: two nodes replaying the same log with the same membership reach identical states", () => {
  const log: MeshMessage[] = [
    msg("gcs.signal", GCS_MAC, { threat: "missile" }, 1000, "t1"),
    msg("track.engaging", GCS_VM, { trackId: "t1" }, 1500),
    msg("gcs.signal", GCS_VM, { threat: "swarm" }, 2000, "t2"),
    msg("track.neutralised", GCS_MAC, { trackId: "t1" }, 2500), // rejected: mac not responsible
    msg("track.handover", GCS_VM, { trackId: "t1" }, 3000),
    msg("track.neutralised", GCS_MAC, { trackId: "t1" }, 3500), // now accepted
  ];
  const run = (order: MeshMessage[]) => {
    const st = createEngagement();
    for (const m of order) applyMessage(st, m, ctx(m.at + 50), CHAIN);
    tick(st, ctx(4000));
    return JSON.stringify([...st.tracks.values()].map((t) => ({ id: t.trackId, s: t.state, r: responsibleNode(t), e: t.escalations.map((e) => e.reason), rej: t.rejected.length })));
  };
  const a = run(log);
  const b = run([log[0], log[2], log[1], log[3], log[4], log[5]]); // different interleaving of unrelated tracks
  assert.equal(a, b);
  assert.match(a, /"s":"neutralised"/);
});

test("impact is terminal, only the origin may report it, and it records the final position", () => {
  const st = createEngagement();
  applyMessage(st, msg("track.detected", GCS_MAC, { threat: "missile", target: "asset-changi", pos: { lat: 1.2, lng: 103.8 } }, 1000, "t1"), ctx(1000), CHAIN);
  assert.equal(st.tracks.get("t1")!.target, "asset-changi");
  applyMessage(st, msg("track.impact", GCS_VM, { trackId: "t1", lat: 1.35, lng: 103.99 }, 5000), ctx(5000));
  assert.equal(st.tracks.get("t1")!.state, "detected", "vm is not the origin");
  applyMessage(st, msg("track.impact", GCS_MAC, { trackId: "t1", lat: 1.35, lng: 103.99 }, 6000), ctx(6000));
  const t = st.tracks.get("t1")!;
  assert.equal(t.state, "impact");
  assert.equal(t.positions.at(-1)!.lat, 1.35);
  applyMessage(st, msg("track.neutralised", GCS_VM, { trackId: "t1" }, 7000), ctx(7000));
  assert.equal(t.state, "impact", "too late");
});

test("late joiner: replaying the whole log in one burst reaches the same lifecycle as a node that saw it live", () => {
  // This is what lets G2 skip track.snapshot: a node that boots mid-engagement
  // and receives the (re-flooded) log converges on the same state and positions.
  const log: MeshMessage[] = [
    msg("track.detected", GCS_MAC, { threat: "missile", target: "asset-changi", pos: { lat: 1.2, lng: 103.8 } }, 1000, "t1"),
    msg("track.update", GCS_MAC, { trackId: "t1", seq: 1, lat: 1.21, lng: 103.81 }, 2000),
    msg("track.engaging", GCS_VM, { trackId: "t1" }, 2500),
    msg("track.update", GCS_MAC, { trackId: "t1", seq: 2, lat: 1.22, lng: 103.82 }, 3000),
    msg("track.handover", GCS_VM, { trackId: "t1", note: "hand to mac" }, 3500),
    msg("track.update", GCS_MAC, { trackId: "t1", seq: 3, lat: 1.23, lng: 103.83 }, 4000),
    msg("track.neutralised", GCS_MAC, { trackId: "t1" }, 4500),
  ];
  const summary = (st: ReturnType<typeof createEngagement>) => {
    const t = st.tracks.get("t1")!;
    return JSON.stringify({ s: t.state, r: responsibleNode(t), e: t.escalations.map((e) => [e.reason, e.from, e.to]), by: t.neutralised?.device, pos: t.positions.map((p) => p.seq), rej: t.rejected.length });
  };
  const live = createEngagement();
  for (const m of log) { applyMessage(live, m, ctx(m.at + 20), CHAIN); tick(live, ctx(m.at + 40)); }
  const late = createEngagement();
  for (const m of log) applyMessage(late, m, ctx(60_000), CHAIN); // everything at once, a minute later
  tick(late, ctx(60_000));
  assert.equal(summary(late), summary(live));
  assert.match(summary(live), /"s":"neutralised".*"pos":\[0,1,2,3\]/);
});
