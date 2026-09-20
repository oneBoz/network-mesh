import { test } from "node:test";
import assert from "node:assert/strict";
import { Membership } from "../src/swim.js";
import type { PeerInfo } from "../src/protocol.js";

const peer = (id: string, port = 4000): PeerInfo => ({ id, host: "10.0.0.1", port });

/** Run `fn` with Date.now() pinned to `t` (ms). */
function at<T>(t: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => t;
  try { return fn(); } finally { Date.now = real; }
}

test("a rumor about an unknown member creates no entry — members enter with an address", () => {
  const m = new Membership("me");
  assert.equal(m.applyRumor({ id: "ghost", status: "dead", inc: 3 }), "stale");
  assert.equal(m.applyRumor({ id: "ghost", status: "suspect", inc: 0 }), "stale");
  assert.equal(m.applyRumor({ id: "ghost", status: "alive", inc: 0 }), "stale");
  assert.equal(m.entry("ghost"), undefined);
  assert.deepEqual(m.snapshot(), {});
  // With an address it is a member, and rumors apply as usual.
  assert.equal(m.upsertPeer(peer("x")), "added");
  assert.equal(m.applyRumor({ id: "x", status: "dead", inc: 0 }), "applied");
  assert.equal(m.status("x"), "dead");
});

test("upsertPeer reports what it did and only direct packets move an address", () => {
  const m = new Membership("me");
  assert.equal(m.upsertPeer(peer("x", 1)), "added");
  assert.equal(m.upsertPeer(peer("x", 2)), "updated");
  assert.equal(m.peer("x")?.port, 1, "hearsay does not move an address");
  assert.equal(m.upsertPeer(peer("x", 3), true), "updated");
  assert.equal(m.peer("x")?.port, 3, "a direct packet does");
  assert.equal(m.upsertPeer(peer("me")), "rejected");
  assert.equal(m.upsertPeer({ id: "", host: "h", port: 1 }), "rejected");
});

test("dead peers are pruned, then tombstoned: hearsay is held, first-hand evidence re-admits", () => {
  const m = new Membership("me");
  const events: string[] = [];
  const mm = new Membership("me", (e) => events.push(`${e.id}:${e.from}>${e.to}`));
  for (const x of [m, mm]) {
    at(0, () => x.upsertPeer(peer("x")));
    at(0, () => x.applyRumor({ id: "x", status: "dead", inc: 2 }));
  }
  // Not yet pruned: still in the view and still in allPeers (gossiped), never a probe candidate.
  at(29_000, () => m.sweep(5_000, 30_000, 600_000));
  assert.equal(m.status("x"), "dead");
  assert.equal(m.probeCandidates().length, 0);
  assert.equal(m.deadPeers().length, 1);
  // Pruned: gone from the view, address forgotten, id tombstoned.
  at(31_000, () => { m.sweep(5_000, 30_000, 600_000); mm.sweep(5_000, 30_000, 600_000); });
  assert.equal(m.entry("x"), undefined);
  assert.equal(m.peer("x"), undefined);
  assert.equal(m.tombstoned("x"), true);
  assert.deepEqual(Object.keys(m.forgotten()), ["x"]);
  assert.equal(m.rumors().length, 1, "only our own rumor is left");
  // A lighthouse or a slower neighbour offering x again is held back, not believed.
  assert.equal(m.upsertPeer(peer("x")), "held");
  assert.equal(m.entry("x"), undefined);
  assert.equal(m.applyRumor({ id: "x", status: "alive", inc: 0 }), "stale");
  assert.equal(m.entry("x"), undefined);
  // x itself shows up (restart, or reconnect): admitted at once, tombstone cleared.
  assert.equal(mm.upsertPeer(peer("x"), true), "added");
  assert.equal(mm.status("x"), "alive");
  assert.equal(mm.tombstoned("x"), false);
  assert.deepEqual(events, ["x:unknown>alive", "x:alive>dead", "x:unknown>alive"]);
  // An answer to our own probe relayed by a helper is first-hand too, but keeps our address.
  assert.equal(m.upsertPeer(peer("x", 9), false, true), "added");
  assert.equal(m.status("x"), "alive");
  assert.equal(m.tombstoned("x"), false);
});

test("a tombstone expires after forgetMs, and hearsay is trusted again", () => {
  const m = new Membership("me");
  at(0, () => m.upsertPeer(peer("x")));
  at(0, () => m.applyRumor({ id: "x", status: "dead", inc: 0 }));
  at(31_000, () => m.sweep(5_000, 30_000, 60_000));
  assert.equal(m.tombstoned("x"), true);
  at(90_000, () => m.sweep(5_000, 30_000, 60_000));
  assert.equal(m.tombstoned("x"), true, "60 s after the prune it still holds");
  at(92_000, () => m.sweep(5_000, 30_000, 60_000));
  assert.equal(m.tombstoned("x"), false);
  assert.equal(m.upsertPeer(peer("x")), "added");
});

test("two nodes that convicted a peer at different times both forget it (no rumor ping-pong)", () => {
  // Before: A prunes x, B (still holding x dead) gossips the death rumor back,
  // A re-creates x with a fresh timestamp and gossips it after B prunes — the
  // corpse circulates forever. Now a rumor about an unknown id is ignored.
  const a = new Membership("a"), b = new Membership("b");
  at(0, () => { a.upsertPeer(peer("x")); b.upsertPeer(peer("x")); });
  at(0, () => a.applyRumor({ id: "x", status: "dead", inc: 0 }));
  at(10_000, () => b.applyRumor({ id: "x", status: "dead", inc: 0 }));
  const exchange = (t: number) => at(t, () => {
    for (const r of a.rumors()) b.applyRumor(r);
    for (const r of b.rumors()) a.applyRumor(r);
    for (const p of a.probeCandidates()) b.upsertPeer(p);
    for (const p of b.probeCandidates()) a.upsertPeer(p);
  });
  for (let t = 1_000; t <= 60_000; t += 1_000) {
    at(t, () => { a.sweep(5_000, 30_000, 600_000); b.sweep(5_000, 30_000, 600_000); });
    exchange(t);
  }
  assert.equal(a.entry("x"), undefined);
  assert.equal(b.entry("x"), undefined);
  assert.equal(a.rumors().length, 1);
  assert.equal(b.rumors().length, 1);
});
