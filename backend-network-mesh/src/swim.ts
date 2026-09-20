/**
 * swim.ts — the SWIM membership engine, as a pure state machine.
 *
 * No sockets, no timers of its own: the transport (node.ts) drives it by
 * calling markAlive / markSuspect / applyRumor / sweep. Keeping the algorithm
 * I/O-free means the exact same logic can be unit-tested, embedded in the
 * browser simulator, or swapped onto a different transport later.
 */
import type { NodeStatus, PeerInfo, Rumor } from "./protocol.js";
import { supersedes } from "./protocol.js";

export interface MemberEntry {
  status: NodeStatus;
  inc: number;
  since: number; // ms timestamp of last status change
}

export interface MembershipEvent {
  id: string;
  from: NodeStatus | "unknown";
  to: NodeStatus;
}

/** What upsertPeer did with a record:
 *  - "added": a new member entered the view (alive, incarnation 0);
 *  - "updated": an existing member's record was refreshed;
 *  - "held": the id was pruned recently and this was hearsay — nothing changed,
 *    the caller should verify the address with a probe (see node.ts);
 *  - "rejected": malformed, or our own id. */
export type UpsertResult = "added" | "updated" | "held" | "rejected";

export class Membership {
  readonly selfId: string;
  selfInc = 0;
  private view = new Map<string, MemberEntry>();
  private peers = new Map<string, PeerInfo>();
  // Times each member's rumor has been piggybacked since it last changed —
  // rumors() sends the least-gossiped first so a size cap still spreads news.
  private sends = new Map<string, number>();
  // Members pruned after dying: id → { inc they died at, when pruned }. While an
  // id is here, hearsay (a peer list from a lighthouse or another node) cannot
  // re-admit it — only a packet from the node itself, or an ack to our own
  // probe. Without this, a stale lighthouse registry or a slower neighbour
  // re-seeds every pruned node as a fresh "alive" member, which is then
  // re-suspected, re-convicted and re-pruned: a phantom that flaps forever.
  private tombstones = new Map<string, { inc: number; at: number }>();

  private onChange?: (e: MembershipEvent) => void;

  constructor(selfId: string, onChange?: (e: MembershipEvent) => void) {
    this.selfId = selfId;
    this.onChange = onChange;
  }

  /** Learn (or refresh) a peer's address. Idempotent.
   *  Only a packet received directly from the peer itself (`direct`) may
   *  change a known address — relayed gossip can carry stale or wildcard
   *  ("0.0.0.0") addresses observed by third parties.
   *  `verified` (defaults to `direct`) says the record is first-hand evidence
   *  that the node is up right now — it clears a tombstone. A relayed ack to
   *  our own probe is verified but not direct: the node answered, but the
   *  address in it is what the helper sees, not necessarily what we can reach. */
  upsertPeer(info: PeerInfo, direct = false, verified = direct): UpsertResult {
    // Peers lists come off the wire — reject entries that lack a usable
    // identity or address rather than letting them pollute the view.
    if (!info || typeof info.id !== "string" || !info.id) return "rejected";
    if (typeof info.host !== "string" || typeof info.port !== "number") return "rejected";
    if (info.id === this.selfId) return "rejected";
    if (this.tombstones.has(info.id)) {
      if (!verified) return "held";
      this.tombstones.delete(info.id);
    }
    const existing = this.peers.get(info.id);
    const wildcard = info.host === "0.0.0.0" || info.host === "";
    if (existing && (!direct || wildcard)) {
      this.peers.set(info.id, { ...info, host: existing.host, port: existing.port });
    } else {
      this.peers.set(info.id, info);
    }
    if (!this.view.has(info.id)) {
      this.view.set(info.id, { status: "alive", inc: 0, since: Date.now() });
      this.onChange?.({ id: info.id, from: "unknown", to: "alive" });
      return "added";
    }
    return "updated";
  }

  /** True while `id` was pruned recently and is admitted only on first-hand evidence. */
  tombstoned(id: string): boolean {
    return this.tombstones.has(id);
  }

  /** Recently pruned members: id → ms timestamp of the prune. */
  forgotten(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, t] of this.tombstones) out[id] = t.at;
    return out;
  }

  allPeers(): PeerInfo[] {
    return [...this.peers.values()];
  }

  /** One peer's record — O(1); use instead of scanning allPeers(). */
  peer(id: string): PeerInfo | undefined {
    return this.peers.get(id);
  }

  /** One member's status, undefined if unknown — O(1). */
  status(id: string): NodeStatus | undefined {
    return this.view.get(id)?.status;
  }

  /** Direct evidence: we just heard from this node. */
  markAlive(id: string, inc: number): void {
    this.transition(id, { id, status: "alive", inc });
  }

  /** Direct evidence: our probe to this node timed out. */
  markSuspect(id: string): void {
    const cur = this.view.get(id);
    if (!cur || cur.status !== "alive") return;
    this.transition(id, { id, status: "suspect", inc: cur.inc });
  }

  /**
   * Gossip evidence. Returns "refute" if the rumor claims *we* are
   * suspect/dead — the caller must bump selfInc and gossip the refutation.
   */
  applyRumor(r: Rumor): "applied" | "stale" | "refute" {
    if (r.id === this.selfId) {
      if (r.status !== "alive" && r.inc >= this.selfInc) {
        this.selfInc = r.inc + 1; // I'm alive! Override the rumor.
        return "refute";
      }
      return "stale";
    }
    return this.transition(r.id, r) ? "applied" : "stale";
  }

  /** Age suspicions into deaths, and eventually forget the dead entirely.
   *  Call once per protocol period. Dead entries linger for `pruneDeadAfterMs`
   *  so the death rumor still propagates, then are dropped — otherwise the
   *  view (and every piggybacked rumor set) grows without bound under churn.
   *  A pruned id is tombstoned for `forgetMs`: until then it re-enters the
   *  view only on first-hand evidence (see upsertPeer), never on hearsay. */
  sweep(suspectTimeoutMs: number, pruneDeadAfterMs = Infinity, forgetMs = Infinity): void {
    const now = Date.now();
    for (const [id, e] of this.view) {
      if (e.status === "suspect" && now - e.since > suspectTimeoutMs) {
        this.transition(id, { id, status: "dead", inc: e.inc });
      } else if (e.status === "dead" && now - e.since > pruneDeadAfterMs) {
        this.view.delete(id);
        this.peers.delete(id);
        this.sends.delete(id);
        this.tombstones.set(id, { inc: e.inc, at: now });
      }
    }
    for (const [id, t] of this.tombstones) {
      if (now - t.at > forgetMs) this.tombstones.delete(id);
    }
  }

  /** Rumors to piggyback on the next message, capped at `limit` entries so
   *  packets stay under the UDP MTU as the mesh grows. Our own alive rumor is
   *  always first; the rest go least-recently-gossiped first, so every rumor
   *  still reaches everyone — just spread over several packets. Report what
   *  actually went out with noteGossiped(): the size trim may drop some. */
  rumors(limit = Infinity): Rumor[] {
    const out: Rumor[] = [{ id: this.selfId, status: "alive", inc: this.selfInc }];
    const entries = [...this.view.entries()].sort(
      (a, b) => (this.sends.get(a[0]) ?? 0) - (this.sends.get(b[0]) ?? 0)
    );
    for (const [id, e] of entries) {
      if (out.length >= limit) break;
      out.push({ id, status: e.status, inc: e.inc });
    }
    return out;
  }

  /** Count a send for each rumor that made it onto the wire. */
  noteGossiped(sent: Rumor[]): void {
    for (const r of sent) if (r.id !== this.selfId) this.sends.set(r.id, (this.sends.get(r.id) ?? 0) + 1);
  }

  /** Peers we might productively probe (not known-dead). Also the only peers
   *  whose addresses we pass on: a dead peer's record is gossiped by nobody, so
   *  once every node has convicted it, nothing can re-seed it into a node that
   *  has already pruned it. */
  probeCandidates(): PeerInfo[] {
    return this.allPeers().filter((p) => this.view.get(p.id)?.status !== "dead");
  }

  /** Dead-but-not-yet-pruned peers. The transport occasionally pings one as a
   *  resurrection probe: if the "dead" node answers, the rumors piggybacked on
   *  our ping tell it it's been declared dead, it refutes with a higher
   *  incarnation, and its ack brings it back — healing false convictions that
   *  gossip alone can't reverse (nobody probes the dead). */
  deadPeers(): PeerInfo[] {
    return this.allPeers().filter((p) => this.view.get(p.id)?.status === "dead");
  }

  /** All alive peers regardless of service — the matchmaking candidate pool. */
  alivePeers(): PeerInfo[] {
    return this.allPeers().filter((p) => this.view.get(p.id)?.status === "alive");
  }

  /** Healthy instances of a service — the "DNS answer". */
  healthy(service: string): PeerInfo[] {
    return this.allPeers().filter(
      (p) => p.service === service && this.view.get(p.id)?.status === "alive"
    );
  }

  /** One member's current entry (status, incarnation, when it last changed). */
  entry(id: string): MemberEntry | undefined {
    return this.view.get(id);
  }

  snapshot(): Record<string, MemberEntry & { info?: PeerInfo }> {
    const out: Record<string, MemberEntry & { info?: PeerInfo }> = {};
    for (const [id, e] of this.view) out[id] = { ...e, info: this.peers.get(id) };
    return out;
  }

  private transition(id: string, r: Rumor): boolean {
    const cur = this.view.get(id);
    // A rumor about a member we do not know is ignored (as in memberlist): a
    // member enters the view only with an address, via upsertPeer. Otherwise a
    // neighbour that has not pruned a dead node yet re-creates it here with a
    // fresh timestamp, we gossip it back after it prunes — and the pair keeps
    // the corpse alive between them indefinitely.
    if (!cur) return false;
    if (!supersedes(r, cur)) return false;
    const from = cur?.status ?? "unknown";
    this.view.set(id, { status: r.status, inc: r.inc, since: Date.now() });
    this.sends.set(id, 0); // fresh news — gossip it with priority
    if (from !== r.status) this.onChange?.({ id, from, to: r.status });
    return true;
  }
}
