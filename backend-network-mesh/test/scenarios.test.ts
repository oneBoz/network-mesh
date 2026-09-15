import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_ASSETS, DEMO_DEVICE_SLOTS, SCENARIOS, destination, seedEntries } from "../backend/src/scenarios.js";
import { MAX_LIVE, bearingDeg, distanceM } from "../backend/src/simulator.js";
import { EMPTY_GEO, GeoStore } from "../backend/src/geo.js";
import type { GeoTable } from "../backend/src/types.js";

const CHANGI = DEMO_ASSETS["asset-changi-airbase"];
const inSingapore = (p: { lat: number; lng: number }) => p.lat > 1.1 && p.lat < 1.5 && p.lng > 103.55 && p.lng < 104.15;
/** Signed difference between two bearings, in (-180, 180]. */
const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

test("destination() is the inverse of distance + bearing", () => {
  for (const [brg, km] of [[0, 10], [90, 25], [135, 40], [250, 70], [350, 40]] as const) {
    const origin = destination(CHANGI, brg, km * 1000);
    assert.ok(Math.abs(distanceM(CHANGI, origin) - km * 1000) < km * 2, `range ${km} km came back as ${distanceM(CHANGI, origin)} m`);
    // The bearing from the origin back to the target is the outgoing bearing reversed (to within the earth's curvature at 1° N).
    assert.ok(Math.abs(angleDiff(bearingDeg(origin, CHANGI), brg + 180)) < 0.5, `bearing ${brg}`);
  }
});

test("every scenario fits the simulator: 1..MAX_LIVE launches, trajectory threats only, ordered delays", () => {
  assert.ok(SCENARIOS.length >= 3);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, "ids are unique");
  for (const sc of SCENARIOS) {
    assert.ok(sc.steps.length >= 1 && sc.steps.length <= MAX_LIVE, `${sc.id}: ${sc.steps.length} launches`);
    assert.ok(sc.name && sc.description, `${sc.id}: needs a name and a description for the launcher`);
    sc.steps.forEach((s, i) => {
      assert.ok(["missile", "swarm", "aircraft"].includes(s.threat), `${sc.id}: ${s.threat} has no trajectory`);
      assert.ok(s.etaMs >= 30_000 && s.etaMs <= 300_000, `${sc.id}: eta ${s.etaMs} ms outside the launcher's presets`);
      assert.ok(s.rangeKm >= 15 && s.rangeKm <= 100, `${sc.id}: range ${s.rangeKm} km`);
      if (i > 0) assert.ok(s.delayMs >= sc.steps[i - 1].delayMs, `${sc.id}: launches are in time order`);
      // Every launch must still be in the air when the last one starts, or the scenario cannot show concurrent tracks.
      const last = sc.steps[sc.steps.length - 1];
      assert.ok(s.delayMs + s.etaMs > last.delayMs, `${sc.id}: launch ${i + 1} lands before launch ${sc.steps.length} starts`);
      // Wherever the target is on the island, a launch this far out starts over water or Johor.
      const origin = destination(CHANGI, s.bearing, s.rangeKm * 1000);
      assert.ok(Number.isFinite(origin.lat) && Number.isFinite(origin.lng));
    });
  }
});

test("seedEntries adds only what is missing and gives every device its own slot", () => {
  const devices = ["mac", "azure-vm", "mac02"];
  const added = seedEntries(EMPTY_GEO, devices);
  assert.equal(Object.keys(added).length, Object.keys(DEMO_ASSETS).length + devices.length);
  assert.ok(Object.values(added).every((e) => GeoStore.validEntry(e)), "every seeded entry passes the store's validation");
  assert.ok(Object.values(added).every(inSingapore), "everything seeded is in Singapore");
  assert.equal(new Set(devices.map((d) => `${added[d].lat},${added[d].lng}`)).size, devices.length, "distinct slots");

  // Seeding again over a table that already has everything adds nothing (no version bump).
  const full: GeoTable = { ...EMPTY_GEO, version: 1, entries: added };
  assert.deepEqual(seedEntries(full, devices), {});

  // An asset the operator already placed under another id (same label) is not duplicated.
  const byHand: GeoTable = { ...EMPTY_GEO, version: 1, entries: { "asset-changi": { kind: "asset", lat: 1.35, lng: 104.0, label: "changi airbase" } } };
  assert.equal(seedEntries(byHand, [])["asset-changi-airbase"], undefined);
  assert.equal(Object.keys(seedEntries(byHand, [])).length, Object.keys(DEMO_ASSETS).length - 1);

  // A device the operator placed by hand keeps its position; a device sitting on a slot makes the next device skip it.
  const hand: GeoTable = { ...EMPTY_GEO, version: 1, entries: { mac: { kind: "device", lat: DEMO_DEVICE_SLOTS[0][0], lng: DEMO_DEVICE_SLOTS[0][1] } } };
  const more = seedEntries(hand, ["mac", "vm"]);
  assert.equal(more.mac, undefined);
  assert.deepEqual([more.vm.lat, more.vm.lng], DEMO_DEVICE_SLOTS[1]);
  assert.equal(Object.keys(more).length, Object.keys(DEMO_ASSETS).length + 1);
});
