/**
 * node.ts — a regular mesh server.
 *
 * Responsibilities:
 *   - Join via any reachable lighthouse (tries each in order, retries forever).
 *   - Run the SWIM loop: every PROTOCOL_PERIOD, probe one random peer;
 *     timeout → suspect; suspicion timeout → dead; every message piggybacks
 *     rumors + peer addresses so knowledge spreads epidemically.
 *   - Refute false rumors about itself by bumping its incarnation number.
 *   - Forget the dead for good: a dead peer is pruned after DEAD_PRUNE_MS and
 *     its id tombstoned, so a stale lighthouse registry or a slower neighbour
 *     cannot re-seed it as "alive" — a re-offered address is probed first and
 *     admitted only if it answers (see verify()).
 *   - Serve a tiny HTTP query API — the "Consul DNS" equivalent:
 *       GET /members            → this node's membership view
 *       GET /resolve/<service>  → healthy instances of a service
 *       GET /health             → 200 ok (for external monitors)
 *
 * Usage:
 *   npx tsx src/node.ts --id A1 --port 4001 --http 8001 --service api \
 *     --lighthouses 127.0.0.1:5001,127.0.0.1:5002,127.0.0.1:5003
 *
 *   --advertise <public-ip-or-dns>   required when this node shares a machine
 *     with a lighthouse it joins over loopback (e.g. a VPS): otherwise the
 *     lighthouse records it as 127.0.0.1 and internet peers can never reach it.
 */
import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { makeLogger, parseArgs } from "./cli.js";
import { Membership } from "./swim.js";
import type { MeshMessage, Message, PeerInfo, Rumor, Skills, ThreatEvent, ThreatType } from "./protocol.js";
import { decode, encode, observed, trimToFit } from "./protocol.js";
import type { Assignment } from "./skills.js";
import { applyMessage as applyLifecycle, createEngagement, DEFAULT_ENGAGE_TIMEOUT_MS, DEFAULT_LOST_AFTER_MS, isDetection, LIFECYCLE_KINDS, responsibleNode, serialize as serializeTracks, tick as tickLifecycle } from "./engagement.js";
import type { EngagementContext } from "./engagement.js";
import { matchmake, SKILL_TABLE, THREAT_TYPES, toAssignment } from "./skills.js";

// ---------- config ----------
const args = parseArgs(process.argv.slice(2));
const ID = args.id ?? `node-${Math.random().toString(36).slice(2, 7)}`;
// Query-API access token (NODE_API_TOKEN, set by the control plane for every child).
// When present, every HTTP request except /health must carry `Authorization: Bearer <token>`.
const API_TOKEN = process.env.NODE_API_TOKEN?.trim() ?? "";
const PORT = Number(args.port ?? 4001);
const HTTP_PORT = Number(args.http ?? PORT + 4000);
const SERVICE = args.service;
const ADVERTISE = args.advertise && args.advertise !== "true" ? args.advertise : undefined;
// Which machine we run on — shown by dashboards next to remote peers/messages.
const DEVICE = args.device && args.device !== "true" ? args.device : hostname();
const LIGHTHOUSES = (args.lighthouses ?? "").split(",").filter(Boolean).map((s) => {
  const [host, port] = s.split(":");
  return { host, port: Number(port) };
});

// Timers. MESH_PROFILE picks a preset; any individual *_MS variable overrides it.
//   local    — loopback / LAN demo (default)
//   internet — home broadband behind NAT, tens of ms RTT
//   mobile   — phone hotspot / carrier NAT: 100-300 ms RTT with jitter, UDP
//              mappings that idle out in ~30 s, so faster keepalives and
//              longer patience before suspecting anyone
type Profile = { ack: number; indirect: number; suspect: number; keepalive: number };
const PROFILES: Record<string, Profile> = {
  local: { ack: 600, indirect: 1_000, suspect: 5_000, keepalive: 8_000 },
  internet: { ack: 800, indirect: 1_200, suspect: 8_000, keepalive: 8_000 },
  mobile: { ack: 1_000, indirect: 1_500, suspect: 10_000, keepalive: 5_000 },
};
const PROFILE_NAME = process.env.MESH_PROFILE && PROFILES[process.env.MESH_PROFILE] ? process.env.MESH_PROFILE : "local";
const PROFILE = PROFILES[PROFILE_NAME];
const envMs = (name: string, dflt: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
const PROTOCOL_PERIOD_MS = envMs("PROTOCOL_PERIOD_MS", 1_000); // one probe per second (jittered ±10% to avoid lockstep)
const ACK_TIMEOUT_MS = envMs("ACK_TIMEOUT_MS", PROFILE.ack); // direct probe considered failed after this
const INDIRECT_PROBES = 2; // helpers asked to probe on our behalf after a direct timeout
const INDIRECT_TIMEOUT_MS = envMs("INDIRECT_TIMEOUT_MS", PROFILE.indirect); // extra wait for a relayed ack before suspecting (two internet hops each way when the helper is a relay)
const SUSPECT_TIMEOUT_MS = envMs("SUSPECT_TIMEOUT_MS", PROFILE.suspect); // base suspect → dead window; scaled up with mesh size
const DEAD_PRUNE_MS = 30_000; // forget dead peers after this (bounds view + packet size)
const FORGET_MS = 10 * 60_000; // a pruned id is re-admitted only on first-hand evidence for this long (see verify)
const VERIFY_EVERY_MS = 10_000; // at most one verification probe per pruned id per this interval
const ANNOUNCE_INTERVAL_MS = 30_000; // keepalive to lighthouses; the reply doubles as an anti-entropy refresh
const REJOIN_MS = 10_000; // re-query lighthouses if our whole view has emptied
const MAX_PIGGYBACK = 24; // peer records offered per packet before size trimming (see gossipPayload)
const MAX_RUMORS_PER_PACKET = 8; // rumors are cheap but numerous; cap them so peer records still fit
const RESURRECT_EVERY_TICKS = 5; // how often to ping one known-dead peer (false-conviction healing)
const SAVE_PEERS_MS = 30_000; // persist known peer addresses for rejoin-after-restart
const KEEPALIVE_MS = envMs("KEEPALIVE_MS", PROFILE.keepalive); // NAT keepalive to every peer on another machine (UDP NAT idle timeouts: ~30 s home, sometimes < 20 s on carriers)
// Relay-aware probing: after this many direct-probe failures that a relayed
// ack then rescued, stop trying the direct path first and probe via helpers;
// retry the direct path every DIRECT_RETRY_MS in case the NAT opened up.
const RELAY_AFTER_FAILS = 3;
const DIRECT_RETRY_MS = envMs("DIRECT_RETRY_MS", 30_000);
const PEERS_FILE = joinPath(tmpdir(), `mesh-peers-${args.id ?? "anon"}-${Number(args.port ?? 4001)}.json`);

/** Suspect → dead window, scaled with view size like memberlist: rumors need
 *  ~log(n) gossip rounds to reach everyone, so bigger meshes get more time to
 *  deliver a refutation before a conviction. 5s up to ~a dozen nodes. */
function suspectTimeoutMs(): number {
  const n = membership.allPeers().length;
  return SUSPECT_TIMEOUT_MS * Math.max(1, Math.ceil(Math.log2(n + 2) / 3));
}

const log = makeLogger(ID);

// --skills '<json>' overrides; otherwise the service name looks up the default
// table. A node with neither simply never matches a threat.
function parseSkills(raw: string | undefined): Skills | undefined {
  if (!raw) return SERVICE ? SKILL_TABLE[SERVICE] : undefined;
  try {
    const s = JSON.parse(raw) as Skills;
    return Array.isArray(s.threats) && typeof s.layer === "number" && typeof s.cost === "number"
      ? s : undefined;
  } catch {
    return undefined;
  }
}
const SKILLS = parseSkills(args.skills);

const self: PeerInfo = {
  id: ID, host: ADVERTISE ?? "0.0.0.0", port: PORT, httpPort: HTTP_PORT, service: SERVICE, skills: SKILLS,
  device: DEVICE,
  ...(ADVERTISE ? { advertise: ADVERTISE } : {}),
};

// ---------- membership ----------
const membership = new Membership(ID, (e) => {
  const color = e.to === "alive" ? "\x1b[32m" : e.to === "suspect" ? "\x1b[33m" : "\x1b[31m";
  log(`${color}${e.id}: ${e.from} → ${e.to}\x1b[0m`);
});

// ---------- UDP transport ----------
const sock: Socket = createSocket("udp4");
let seq = 0;
const pendingAcks = new Map<number, { target: string; timer: NodeJS.Timeout }>();
// Probes we're running on someone else's behalf (we're the ping-req helper):
// our proxy seq → where to forward the ack and under which original seq.
const pendingProxies = new Map<
  number,
  { origin: { host: string; port: number }; originSeq: number; targetId: string }
>();

// Without this, any send error (oversized datagram, DNS failure on a
// lighthouse hostname, ...) is an unhandled 'error' event and kills the process.
sock.on("error", (err) => {
  log(`\x1b[31msocket error: ${err.message}\x1b[0m`);
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") process.exit(1);
});

// Throttled per source: a key/clock mismatch arrives at packet rate, one line
// per source per 5 s is enough — with the source address, so a peer on the
// wrong key is identifiable.
const lastDropLog = new Map<string, number>();
function onDrop(reason: string, from: string): void {
  const now = Date.now();
  if (now - (lastDropLog.get(from) ?? 0) < 5_000) return;
  lastDropLog.set(from, now);
  log(`\x1b[33mrejected packet from ${from}: ${reason}\x1b[0m`);
}

sock.on("message", (buf, rinfo) => {
  const msg = decode(buf, (reason) => onDrop(reason, `${rinfo.address}:${rinfo.port}`));
  if (!msg) return;
  // decode() only guarantees valid JSON, not a well-formed Message — a throw
  // here would be an uncaught exception that kills the process, so any packet
  // that doesn't match the shape we expect is logged and dropped.
  try {
    handleMessage(msg, rinfo);
  } catch (err) {
    log(`\x1b[31mdropped malformed ${msg.type ?? "?"} packet from ${rinfo.address}:${rinfo.port}: ${(err as Error).message}\x1b[0m`);
  }
});

function handleMessage(msg: Message, rinfo: { address: string; port: number }): void {
  if (msg.type === "keepalive") {
    // Refresh the sender's observed address; nothing else. Cheapest packet we have.
    if (msg.from && typeof msg.from.id === "string" && msg.from.id) membership.upsertPeer(observed(msg.from, rinfo), true);
    return;
  }
  if (msg.type === "ping" || msg.type === "ping-req" || msg.type === "ack") {
    // Structural validation: without a sender id, a packet would register a
    // phantom peer keyed `undefined` that then spreads through gossip.
    if (typeof msg.from?.id !== "string" || !msg.from.id) return;
    if (msg.type === "ping-req" && (typeof msg.target?.id !== "string" || !msg.target.id)) return;
    // Trust the observed source address/port over the self-reported ones — a
    // node behind NAT (or bound to 0.0.0.0) doesn't know its own reachable
    // address, but we can see exactly where its packet came from. Relayed acks
    // are the exception: the UDP source is the helper, not `from`.
    if (msg.type !== "ack" || !msg.relayed) {
      msg.from = observed(msg.from, rinfo);
    }
  }
  switch (msg.type) {
    case "join": {
      // Peer-assisted join: any mesh member can answer like a lighthouse, so a
      // node with a stale peer list (or no reachable lighthouse) can still
      // bootstrap through anyone it once knew.
      const node = msg.node as PeerInfo | undefined;
      if (!node || typeof node.id !== "string" || !node.id || node.id === ID) return;
      const joiner: PeerInfo = observed(node, rinfo);
      membership.upsertPeer(joiner, true);
      const peers = trimToFit(
        sample(membership.probeCandidates().filter((p) => p.id !== joiner.id), MAX_PIGGYBACK),
        (ps) => ({ type: "join-ack", from: self, peers: ps }), { fromBack: true });
      send(joiner, { type: "join-ack", from: self, peers });
      log(`answered join from ${joiner.id} (peer-assisted)`);
      break;
    }
    case "join-ack": {
      // A peer (not a lighthouse) answered — it told us who it is, and this
      // packet came straight from it, so trust the observed address.
      if (msg.from && typeof msg.from.id === "string" && msg.from.id) {
        membership.upsertPeer(observed(msg.from, rinfo), true);
      }
      // The list itself is hearsay: a lighthouse still hands out a node that
      // died up to STALE_MS ago, so a recently pruned id is verified, not trusted.
      const peers = Array.isArray(msg.peers) ? msg.peers : [];
      for (const p of peers) learn(p);
      if (!joined) {
        joined = true; // even an empty mesh counts as joined
        log(`joined mesh — learned ${peers.length} peers`);
      }
      // Subsequent join-acks are the 30s announce refresh (anti-entropy): the
      // upserts above quietly re-add any peers we pruned during a partition.
      break;
    }
    case "ping": {
      // The sender first (first-hand), then what it piggybacked (hearsay).
      membership.upsertPeer(msg.from, true);
      absorb(msg.rumors, msg.peers);
      send(msg.from, withGossip({ type: "ack", seq: msg.seq, from: self }));
      break;
    }
    case "ping-req": {
      // Probe msg.target on msg.from's behalf; forward any ack we get. The
      // target is NOT entered into our view here — the requester asks because
      // its own probe failed, so the target may well be dead; if it is up, its
      // ack reaches us first-hand and admits it then.
      membership.upsertPeer(msg.from, true);
      absorb(msg.rumors, msg.peers);
      // Prefer our own known address for the target over the requester's copy.
      const target = membership.peer(msg.target.id) ?? msg.target;
      const s = ++seq;
      pendingProxies.set(s, {
        origin: { host: msg.from.host, port: msg.from.port },
        originSeq: msg.seq, targetId: target.id,
      });
      setTimeout(() => pendingProxies.delete(s), ACK_TIMEOUT_MS + 100);
      send(target, withGossip({ type: "ping", seq: s, from: self }));
      break;
    }
    case "ack": {
      // Only the node we actually probed may answer its probe.
      const pending = pendingAcks.get(msg.seq);
      const answered = !!pending && pending.target === msg.from.id;
      // An answer to our own probe is first-hand evidence the node is up even
      // when a helper relayed it (the address then stays what we already hold).
      membership.upsertPeer(msg.from, !msg.relayed, !msg.relayed || answered);
      absorb(msg.rumors, msg.peers);
      // Were we probing this node for someone else? Forward the good news.
      const proxy = pendingProxies.get(msg.seq);
      if (proxy && proxy.targetId === msg.from.id) {
        pendingProxies.delete(msg.seq);
        send(proxy.origin, withGossip({ type: "ack", seq: proxy.originSeq, from: msg.from, relayed: true }));
      }
      if (answered) {
        clearTimeout(pending!.timer);
        pendingAcks.delete(msg.seq);
        if (msg.relayed) noteRelayedAck(msg.from.id); else noteDirectAck(msg.from.id);
      }
      break;
    }
    case "threat": {
      // Application layer only: no absorb(), no upsertPeer() — a threat flood
      // must never influence membership state.
      handleThreat(msg.event, msg.ttl);
      break;
    }
    case "msg": {
      // Data channel: same rules as threat — application layer only.
      ingestMessage(msg.msg, msg.ttl, msg.from?.id);
      break;
    }
  }
}

// ---------- message channel (application layer) ----------
const MSG_FANOUT = 3; // remote (other-device) peers each node forwards a fresh message to
const MSG_RELAYS = 2; // publicly advertised peers always included among the first hops
const MSG_TTL = 4; // flood depth
const MSG_SEEN_TTL_MS = 120_000; // dedupe window per message id
const MAX_INBOX = 200;

/** A message as stored by this node: the wire message plus what we did with it. */
export interface StoredMessage extends MeshMessage {
  receivedAt: number; // our clock
  hop?: string; // peer we received it from (undefined = originated here)
  /** For kind "gcs.signal": the actions this node decided on. Deterministic
   *  matchmaking over the shared view means every node stores the same answer. */
  assignment?: Assignment;
}

const seenMsgs = new Map<string, number>(); // id → first-seen ts
const inbox: StoredMessage[] = [];

// ---------- engagement lifecycle (replicated state machine, see engagement.ts) ----------
const engagement = createEngagement();
const ENGAGE_TIMEOUT_OVERRIDE = Number(process.env.ENGAGE_TIMEOUT_MS) || undefined;
// /tracks stops shipping a finished track's trajectory (up to MAX_POSITIONS points)
// this long after it finished: it is polled every second and nothing draws it any more.
const ARCHIVE_POSITIONS_AFTER_MS = 120_000;
function lifecycleCtx(): EngagementContext {
  return {
    now: Date.now(),
    deviceOf: (id) => (id === ID ? DEVICE : membership.peer(id)?.device),
    isAlive: (id) => id === ID || membership.status(id) === "alive",
    deadFor: (id) => { const e = membership.entry(id); return e?.status === "dead" ? Date.now() - e.since : 0; },
    deadGraceMs: suspectTimeoutMs(), // a false conviction is refuted within about one suspect window
    engageTimeoutMs: (threat) => ENGAGE_TIMEOUT_OVERRIDE ?? DEFAULT_ENGAGE_TIMEOUT_MS[threat],
    lostAfterMs: DEFAULT_LOST_AFTER_MS,
  };
}

function validMessage(m: unknown): m is MeshMessage {
  const x = m as MeshMessage;
  return !!x && typeof x.id === "string" && !!x.id && typeof x.kind === "string" && !!x.kind
    && typeof x.at === "number" && !!x.from && typeof x.from.node === "string"
    && (x.to === undefined || typeof x.to === "string")
    && !!x.body && typeof x.body === "object";
}

/**
 * Ingest a message: dedupe, act on it, store it, forward it.
 * Forwarding: (1) every alive peer on this same device — loopback/LAN, free and
 * reliable, so the local fleet always has it; (2) up to MSG_RELAYS peers that
 * advertise a public address (a VPS node): reachable from every network, so a
 * message crossing NATs takes the reliable hop first; (3) a random sample of
 * the other remote peers, so hole-punched paths are used too.
 */
function ingestMessage(m: unknown, ttl: number, hop?: string): StoredMessage | null {
  if (!validMessage(m)) return null;
  if (seenMsgs.has(m.id)) return null;
  // A re-flooded detection (the simulator re-announces for late joiners) arriving after the dedupe window.
  if (isDetection(m.kind) && engagement.tracks.has(m.id)) return null;
  seenMsgs.set(m.id, Date.now());

  const mine = !m.to || m.to === ID;
  let stored: StoredMessage | null = null;
  if (mine) {
    stored = { ...m, receivedAt: Date.now(), hop };
    if (isDetection(m.kind) && typeof m.body.threat === "string" && THREAT_TYPES.includes(m.body.threat as ThreatType)) {
      stored.assignment = assignLocal({
        threatId: m.id, threat: m.body.threat as ThreatType, at: m.at, origin: m.from.node,
      });
      const a = stored.assignment;
      log(`\x1b[36mSIGNAL ${m.body.threat} from ${m.from.station ?? m.from.node}@${m.from.device ?? "?"} → primary=${a.primary ?? "NONE"} fallbacks=[${a.fallbacks.join(",")}]\x1b[0m`);
      // The ranked assignment is the chain of responsibility for the lifecycle.
      const track = applyLifecycle(engagement, m, lifecycleCtx(), a.ranked.map((r) => r.id));
      if (track) log(`\x1b[36mTRACK ${track.trackId} ${track.state} — responsible ${responsibleNode(track) ?? "NOBODY"}\x1b[0m`);
    } else if (LIFECYCLE_KINDS.has(m.kind)) {
      const track = applyLifecycle(engagement, m, lifecycleCtx());
      if (track && m.kind !== "track.update") {
        const last = track.rejected.at(-1);
        const rejectedNow = last && last.node === m.from.node && Date.now() - last.at < 50;
        log(`\x1b[36mTRACK ${track.trackId} ${m.kind.replace("track.", "")} by ${m.from.station ?? m.from.node}@${m.from.device ?? "?"} → ${rejectedNow ? `REJECTED (${last!.reason})` : `${track.state}, responsible ${responsibleNode(track) ?? "NOBODY"}`}\x1b[0m`);
      }
    } else {
      log(`\x1b[36mMSG ${m.kind} from ${m.from.station ?? m.from.node}@${m.from.device ?? "?"}${hop ? ` via ${hop}` : ""}\x1b[0m`);
    }
    inbox.push(stored);
    if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX);
  }

  if (ttl > 0) forward(m, ttl, hop);
  return stored;
}

/** Flood `m` onward: every same-device peer, the relays, a random remote sample, and a unicast's target. */
function forward(m: MeshMessage, ttl: number, hop?: string): void {
  const alive = membership.alivePeers().filter((p) => p.id !== hop);
  const local = alive.filter((p) => p.device === DEVICE);
  const away = alive.filter((p) => p.device !== DEVICE);
  const relays = sample(away.filter((p) => !!p.advertise), MSG_RELAYS);
  const others = sample(away.filter((p) => !p.advertise), MSG_FANOUT);
  // A unicast we can address directly always goes straight to its target too.
  const direct = m.to ? alive.find((p) => p.id === m.to) : undefined;
  const targets = new Map<string, PeerInfo>();
  for (const p of [...local, ...relays, ...others, ...(direct ? [direct] : [])]) targets.set(p.id, p);
  for (const p of targets.values()) send(p, { type: "msg", msg: m, ttl: ttl - 1, from: self });
}

/** Originate a message from this node (HTTP POST /send). */
function sendMessage(kind: string, body: Record<string, unknown>, to?: string, station?: string): StoredMessage | null {
  const m: MeshMessage = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(), kind, from: { node: ID, device: DEVICE, ...(station ? { station } : {}) },
    ...(to ? { to } : {}), body,
  };
  const stored = ingestMessage(m, MSG_TTL);
  // A unicast to someone else is not "ours": still report what we sent.
  return stored ?? { ...m, receivedAt: Date.now() };
}

// ---------- threat matchmaking (application layer) ----------
const THREAT_FANOUT = 3; // peers each node forwards a fresh threat to
const THREAT_TTL = 3; // flood depth — ceil(log n) + slack at demo scale
const THREAT_SEEN_TTL_MS = 60_000; // dedupe window per threatId

const seenThreats = new Map<string, number>(); // threatId → first-seen ts

/** The pool every decision is computed over: us + every alive peer. */
function candidatePool(): PeerInfo[] {
  return [self, ...membership.alivePeers()];
}

function assignLocal(event: ThreatEvent): Assignment {
  return toAssignment(event, matchmake(event.threat, candidatePool()), ID);
}

/**
 * Ingest a threat: compute OUR assignment from OUR view, log it, and forward
 * the event to a few alive peers. Dedupe by threatId terminates the flood;
 * every node ends up logging the identical assignment — the "one entity" proof.
 */
function handleThreat(event: ThreatEvent, ttl: number): Assignment | null {
  if (!event || typeof event.threatId !== "string" || !event.threatId) return null;
  if (typeof event.threat !== "string" || !THREAT_TYPES.includes(event.threat)) return null;
  if (seenThreats.has(event.threatId)) return null;
  seenThreats.set(event.threatId, Date.now());
  const a = assignLocal(event);
  log(`\x1b[36mTHREAT ${event.threat} [${event.threatId}] → primary=${a.primary ?? "NONE"} fallbacks=[${a.fallbacks.join(",")}]\x1b[0m`);
  if (ttl > 0) {
    for (const p of sample(membership.alivePeers(), THREAT_FANOUT)) {
      send(p, { type: "threat", event, ttl: ttl - 1, from: self });
    }
  }
  return a;
}

/** Uniform random n-subset of `arr` (shuffles `arr` in place). Partial
 *  Fisher-Yates: only the first n slots are drawn, not the whole array. */
function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

const VALID_STATUS = new Set(["alive", "suspect", "dead"]);

/** Take a peer record from hearsay (a piggybacked or join-ack peer list): a new
 *  id enters the view as alive and gets probed like anyone else; a recently
 *  pruned id is verified by a probe instead of being trusted. */
function learn(p: PeerInfo): void {
  if (membership.upsertPeer(p) === "held") verify(p);
}

function absorb(rumors: Rumor[], peers: PeerInfo[]): void {
  if (Array.isArray(peers)) for (const p of peers) learn(p);
  if (!Array.isArray(rumors)) return;
  for (const r of rumors) {
    // Skip structurally invalid rumors — they'd create phantom view entries.
    if (!r || typeof r.id !== "string" || !r.id || typeof r.inc !== "number" || !VALID_STATUS.has(r.status)) continue;
    if (membership.applyRumor(r) === "refute") {
      log(`\x1b[35mrefuting rumor that I am ${r.status} — incarnation now ${membership.selfInc}\x1b[0m`);
      announce("refuted a suspicion — my address may have changed");
    }
  }
}

/** Peer addresses to piggyback: a random sample (so every address still
 *  spreads over time) capped to keep the datagram small, plus always us.
 *  Dead peers are left out: their addresses are useless, and passing them on
 *  is exactly how a node that pruned the corpse would learn it "again". */
function piggybackPeers(): PeerInfo[] {
  return sample(membership.probeCandidates(), MAX_PIGGYBACK - 1).concat(self);
}

/** Attach rumors + peer addresses to a gossip packet, sized so the datagram
 *  never fragments (see MAX_DATAGRAM). Budget: at most MAX_RUMORS_PER_PACKET
 *  rumors (least-recently-gossiped first, so every rumor still gets out), then
 *  as many peer records (~200 B each) as fit in THIS message shape — a random
 *  sample, so every address still spreads within a few packets. Our own record
 *  is always kept so receivers learn where we are. Rumors must NOT crowd peers
 *  out: a member known only by rumor has no address and can never be reached. */
function withGossip(base: Record<string, unknown>): Message {
  const rumors = membership.rumors(MAX_RUMORS_PER_PACKET);
  const build = (ps: PeerInfo[], rs: Rumor[]): Message => ({ ...base, rumors: rs, peers: ps }) as Message;
  const peers = trimToFit(piggybackPeers(), (ps) => build(ps, rumors), { min: 1 }); // self is last → kept
  const fitRumors = trimToFit(rumors, (rs) => build(peers, rs), { fromBack: true, min: 1 });
  membership.noteGossiped(fitRumors); // only what survived the trim counts as gossiped
  return build(peers, fitRumors);
}

function send(to: { host: string; port: number }, msg: Message): void {
  sock.send(encode(msg), to.port, to.host, (err) => {
    if (err) log(`\x1b[31msend to ${to.host}:${to.port} failed: ${err.message}\x1b[0m`);
  });
}

// ---------- per-peer path state (direct vs relay) ----------
// Two devices behind NATs that cannot hole-punch to each other (two hotspots,
// or two laptops behind one non-hairpinning router) can still reach each
// other through a relay. Remember which peers need that, so we do not time out
// a direct probe every round before asking a helper.
interface PathState { mode: "direct" | "relay"; directFails: number; relayOk: number; lastDirectTry: number }
const paths = new Map<string, PathState>();
const pathFor = (id: string): PathState => {
  let p = paths.get(id);
  if (!p) { p = { mode: "direct", directFails: 0, relayOk: 0, lastDirectTry: 0 }; paths.set(id, p); }
  return p;
};
function noteDirectAck(id: string): void {
  const p = pathFor(id);
  if (p.mode === "relay") log(`${id}: direct path is back — probing directly again`);
  p.mode = "direct"; p.directFails = 0; p.relayOk = 0;
}
function noteRelayedAck(id: string): void {
  const p = pathFor(id);
  p.relayOk++;
  if (p.mode === "direct" && p.directFails >= RELAY_AFTER_FAILS) {
    p.mode = "relay";
    log(`\x1b[33m${id}: no direct path (${p.directFails} probes lost, reachable via relay) — probing via helpers first\x1b[0m`);
  }
}
/** Public summary for /members: which peers we can only reach via a relay. */
function pathSummary(): Record<string, "direct" | "relay"> {
  const out: Record<string, "direct" | "relay"> = {};
  for (const [id, p] of paths) if (membership.peer(id)) out[id] = p.mode;
  return out;
}

// ---------- join + announce ----------
let joined = false;
let lastJoinAttempt = 0;
let lastAnnounce = 0;
/** Tell every lighthouse where we are now. Called on the 30 s timer and, rate
 *  limited, right after we refute a suspicion — a burst of suspicions usually
 *  means our NAT mapping changed (hotspot handover), and the lighthouse is how
 *  everyone else learns the new address quickly.
 *  Every lighthouse, not a random one: each keeps its own registry and drops a
 *  node it has not heard from in STALE_MS, so with k lighthouses and one
 *  announce per interval a live node vanished from any given registry
 *  (1-1/k)^misses of the time — and each reply is the anti-entropy refresh, so
 *  fleets on two sites re-merge after a partition within one interval. */
function announce(reason?: string): void {
  if (!LIGHTHOUSES.length) return;
  const now = Date.now();
  if (reason && now - lastAnnounce < 5_000) return;
  lastAnnounce = now;
  for (const lh of LIGHTHOUSES) send(lh, { type: "announce", node: self, inc: membership.selfInc });
  if (reason) log(`re-announced to ${LIGHTHOUSES.length} lighthouse${LIGHTHOUSES.length === 1 ? "" : "s"} (${reason})`);
}

// Last session's peer addresses (best effort — absent on first boot). Used
// only as extra join targets: a node restarted while every lighthouse is down
// can still bootstrap through any surviving peer (see the "join" handler).
// Never upserted directly — stale addresses would pollute the live view.
function loadSavedPeers(): PeerInfo[] {
  try {
    const peers = JSON.parse(readFileSync(PEERS_FILE, "utf8")) as PeerInfo[];
    return Array.isArray(peers) ? peers.filter((p) => p && p.id !== ID) : [];
  } catch {
    return [];
  }
}
const savedPeers = loadSavedPeers();
if (savedPeers.length) log(`loaded ${savedPeers.length} saved peers from last run (join fallback)`);

setInterval(() => {
  const peers = membership.allPeers();
  if (!peers.length) return;
  try {
    writeFileSync(PEERS_FILE, JSON.stringify(peers));
  } catch { /* best effort — a read-only tmpdir just disables the fallback */ }
}, SAVE_PEERS_MS);

function tryJoin(): void {
  if (joined || (LIGHTHOUSES.length === 0 && savedPeers.length === 0)) return;
  lastJoinAttempt = Date.now();
  for (const lh of LIGHTHOUSES) send(lh, { type: "join", node: self, inc: membership.selfInc });
  for (const p of savedPeers.slice(0, 3)) send(p, { type: "join", node: self, inc: membership.selfInc });
  setTimeout(tryJoin, 2_000); // keep retrying until someone answers
}

setInterval(() => announce(), ANNOUNCE_INTERVAL_MS);

// NAT keepalive: peers on other machines only (loopback/LAN needs none). A
// pair's mapping stays open as long as either side sends, so with 8 s here
// nobody's direct probe ever meets a closed mapping.
setInterval(() => {
  const keep: Message = { type: "keepalive", from: self };
  for (const p of membership.probeCandidates()) {
    if (p.device === DEVICE) continue;
    send(p, keep);
  }
}, KEEPALIVE_MS * (0.9 + Math.random() * 0.2));

// ---------- SWIM protocol loop ----------
let tick = 0;
function protocolTick(): void {
  scheduleTick(); // first, so no code path below can stall the loop
  tick++;
  membership.sweep(suspectTimeoutMs(), DEAD_PRUNE_MS, FORGET_MS);
  for (const id of paths.keys()) if (!membership.peer(id)) paths.delete(id);

  // Forget old threat ids so the dedupe map stays bounded.
  const threatCutoff = Date.now() - THREAT_SEEN_TTL_MS;
  for (const [id, ts] of seenThreats) {
    if (ts < threatCutoff) seenThreats.delete(id);
  }
  const msgCutoff = Date.now() - MSG_SEEN_TTL_MS;
  for (const [id, ts] of seenMsgs) {
    if (ts < msgCutoff) seenMsgs.delete(id);
  }
  const verifyCutoff = Date.now() - FORGET_MS;
  for (const [id, ts] of lastVerify) {
    if (ts < verifyCutoff) lastVerify.delete(id);
  }
  // Engagement lifecycle: escalate on dead/timeout, mark silent tracks lost.
  for (const t of tickLifecycle(engagement, lifecycleCtx())) {
    const e = t.escalations.at(-1);
    log(`\x1b[33mTRACK ${t.trackId} ${t.state === "lost" ? "LOST (updates stopped)" : `escalated (${e?.reason}): ${e?.from ?? "nobody"} → ${e?.to ?? "NOBODY LEFT"}`}\x1b[0m`);
  }

  // Resurrection probe: nobody normally pings the dead, so a false conviction
  // (e.g. both sides of a healed partition convicted each other) can never be
  // reversed by gossip alone. Occasionally ping one dead peer anyway — if it
  // answers, the piggybacked rumors trigger its refutation and it comes back.
  if (tick % RESURRECT_EVERY_TICKS === 0) {
    const dead = membership.deadPeers();
    if (dead.length) {
      const d = dead[Math.floor(Math.random() * dead.length)];
      send(d, withGossip({ type: "ping", seq: ++seq, from: self }));
    }
  }

  const candidates = membership.probeCandidates();
  if (!candidates.length) {
    // Our entire view has died or been pruned (e.g. the rest of the fleet
    // restarted). `joined` would otherwise latch true forever — go back to the
    // lighthouses (or last session's peers) so recovery works from both directions.
    if (joined && (LIGHTHOUSES.length > 0 || savedPeers.length > 0)
        && Date.now() - lastJoinAttempt > REJOIN_MS) {
      log("membership view is empty — re-joining");
      joined = false;
      tryJoin();
    }
    return;
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  probe(target, () => membership.markSuspect(target.id));
}

/** One SWIM probe of `target`: a direct ping, then (after ACK_TIMEOUT_MS, or
 *  at once for a peer known to need a relay) ping-reqs through helpers; `onFail`
 *  runs if nobody relays an ack within INDIRECT_TIMEOUT_MS. The ack handler
 *  matches answers by seq and records the path that worked. */
function probe(target: PeerInfo, onFail: () => void): void {
  const s = ++seq;
  const path = pathFor(target.id);
  const relayFirst = path.mode === "relay" && Date.now() - path.lastDirectTry < DIRECT_RETRY_MS;
  if (!relayFirst) {
    path.lastDirectTry = Date.now();
    send(target, withGossip({ type: "ping", seq: s, from: self }));
  }
  const indirect = () => {
    // Direct probe failed (or is known to fail). Before giving up, ask a few
    // peers to try their path (SWIM's indirect probe) — one lossy link shouldn't
    // convict a node.
    if (!relayFirst) path.directFails++;
    const helpers = membership.probeCandidates().filter((p) => p.id !== target.id);
    if (!helpers.length) {
      pendingAcks.delete(s);
      onFail();
      return;
    }
    // Mix the helpers so at least one of them can plausibly reach the target
    // when we cannot:
    //  - one on the target's own device (shares its LAN/NAT: reaches it even
    //    when our path through a NAT is filtered);
    //  - one elsewhere, publicly advertised relays first (reach everyone: the
    //    only path when we and the target sit behind the SAME NAT and the
    //    router does not hairpin, e.g. two laptops on one Wi-Fi).
    // Random helpers fill whatever is left.
    const sameDev = (p: PeerInfo) => !!target.device && p.device === target.device;
    const near = sample(helpers.filter(sameDev), 1);
    const relays = sample(helpers.filter((p) => !sameDev(p) && !!p.advertise), 1);
    const rest = sample(helpers.filter((p) => !sameDev(p) && !p.advertise), INDIRECT_PROBES);
    const chosen = new Map<string, PeerInfo>();
    for (const h of [...near, ...relays, ...rest]) if (chosen.size < INDIRECT_PROBES) chosen.set(h.id, h);
    for (const h of chosen.values()) {
      send(h, withGossip({ type: "ping-req", seq: s, from: self, target }));
    }
    const indirectTimer = setTimeout(() => {
      pendingAcks.delete(s);
      onFail();
    }, INDIRECT_TIMEOUT_MS);
    pendingAcks.set(s, { target: target.id, timer: indirectTimer });
  };
  if (relayFirst) {
    indirect(); // skip the direct attempt: we know it is filtered
  } else {
    const timer = setTimeout(indirect, ACK_TIMEOUT_MS);
    pendingAcks.set(s, { target: target.id, timer });
  }
}

// ---------- verification of recently pruned peers ----------
// A peer list naming a member we pruned is not taken at face value (see
// Membership.tombstones): a lighthouse keeps a dead node registered for
// STALE_MS after its last announce, and a neighbour may not have pruned it yet.
// The offered address is probed instead — directly and through helpers — and
// the node is admitted only when it answers (the ack handler treats an answer
// to our probe as first-hand). A restarted or reconnected device is therefore
// back within one probe; a dead one never flickers back.
const lastVerify = new Map<string, number>();
function verify(p: PeerInfo): void {
  const now = Date.now();
  if (now - (lastVerify.get(p.id) ?? 0) < VERIFY_EVERY_MS) return;
  lastVerify.set(p.id, now);
  probe(p, () => { /* still gone — nothing to change */ });
}

// ±10% jitter so a fleet booted together doesn't probe (and time out) in
// lockstep — synchronized bursts amplify loss into synchronized suspicions.
function scheduleTick(): void {
  setTimeout(protocolTick, PROTOCOL_PERIOD_MS * (0.9 + Math.random() * 0.2));
}
scheduleTick();

// ---------- HTTP query API (the "Consul DNS" stand-in) ----------
/** Build the ThreatEvent, run it through the same path a gossiped threat takes,
 *  and answer with our assignment. Idempotent: a threatId we've already seen
 *  (e.g. the flood beat the HTTP call here) is re-computed without re-flooding. */
function serveThreat(res: import("node:http").ServerResponse, threat: unknown, threatId?: unknown): void {
  if (typeof threat !== "string" || !THREAT_TYPES.includes(threat as ThreatType)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: `unknown threat type — try one of ${THREAT_TYPES.join(", ")}` }));
    return;
  }
  const event: ThreatEvent = {
    threatId: typeof threatId === "string" && threatId
      ? threatId
      : `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    threat: threat as ThreatType,
    at: Date.now(),
    origin: ID,
  };
  const assignment = handleThreat(event, THREAT_TTL) ?? assignLocal(event);
  res.end(JSON.stringify(assignment, null, 2));
}

createServer((req, res) => {
  const url = req.url ?? "/";
  // We bind 0.0.0.0 and don't know our own reachable address — but the client
  // just reached us at req.socket.localAddress, so report that for `self`.
  const selfHost = req.socket.localAddress?.replace(/^::ffff:/, "") ?? self.host;
  res.setHeader("content-type", "application/json");
  if (API_TOKEN && url !== "/health" && req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized — this node's query API needs its control plane's token (Authorization: Bearer <NODE_API_TOKEN>)" }));
    return;
  }
  if (url === "/send" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        // {resend: <id>}: flood a message this node already holds once more. Same id, so
        // everyone who has it drops it; a node that joined mid-track finally gets it.
        if (typeof body.resend === "string") {
          const known = inbox.find((x) => x.id === body.resend);
          if (!known) { res.statusCode = 404; res.end(JSON.stringify({ error: "no such message in this node's inbox" })); return; }
          const { receivedAt: _r, hop: _h, assignment: _a, ...wire } = known;
          forward(wire, MSG_TTL);
          res.end(JSON.stringify({ ok: true, id: known.id, resent: true }));
          return;
        }
        if (typeof body.kind !== "string" || !body.kind) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "kind (string) is required" }));
          return;
        }
        const payload = body.body && typeof body.body === "object" ? body.body as Record<string, unknown> : {};
        if (body.kind === "gcs.signal" && !THREAT_TYPES.includes(payload.threat as ThreatType)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: `gcs.signal needs body.threat ∈ {${THREAT_TYPES.join(", ")}}` }));
          return;
        }
        const stored = sendMessage(body.kind, payload,
          typeof body.to === "string" && body.to ? body.to : undefined,
          typeof body.station === "string" && body.station ? body.station : undefined);
        res.end(JSON.stringify(stored, null, 2));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid JSON body" }));
      }
    });
  } else if (url === "/tracks") {
    // Engagement lifecycle as this node computed it (every node should agree).
    // Polled once a second: tracks that finished a while ago go without their
    // trajectory (ARCHIVE_POSITIONS_AFTER_MS) — the map has stopped drawing them.
    const ctx = lifecycleCtx();
    res.end(JSON.stringify({ node: ID, device: DEVICE, tracks: serializeTracks(engagement).map((t) => {
      const node = responsibleNode(t);
      const finishedAt = t.neutralised?.at ?? t.lostAt ?? t.impactAt;
      const archived = finishedAt !== undefined && ctx.now - finishedAt > ARCHIVE_POSITIONS_AFTER_MS;
      return { ...t, positions: archived ? [] : t.positions, responsibleNode: node, responsibleDevice: node ? ctx.deviceOf(node) : undefined };
    }) }));
  } else if (url.startsWith("/inbox")) {
    // GET /inbox?after=<receivedAt ms> → messages this node stored after that instant.
    const q = new URL(url, "http://x").searchParams;
    const after = Number(q.get("after") ?? 0);
    res.end(JSON.stringify({ node: ID, device: DEVICE, messages: inbox.filter((m) => m.receivedAt > after) }));
  } else if (url === "/threat" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        serveThreat(res, body.threat, body.threatId);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid JSON body" }));
      }
    });
  } else if (url.startsWith("/engage/")) {
    serveThreat(res, url.slice("/engage/".length));
  } else if (url === "/members") {
    // Polled once a second per node by the control plane: compact, not pretty-printed.
    res.end(JSON.stringify({ self: { ...self, host: selfHost, inc: membership.selfInc }, view: membership.snapshot(), paths: pathSummary(), forgotten: membership.forgotten(), profile: PROFILE_NAME }));
  } else if (url.startsWith("/resolve/")) {
    const svc = url.slice("/resolve/".length);
    const healthy = membership.healthy(svc)
      .concat(SERVICE === svc ? [{ ...self, host: selfHost }] : [])
      .map((p) => ({ id: p.id, host: p.host, port: p.port, httpPort: p.httpPort }));
    res.statusCode = healthy.length ? 200 : 404;
    res.end(JSON.stringify({ service: svc, healthy }, null, 2));
  } else if (url === "/health") {
    res.end(JSON.stringify({ ok: true, id: ID }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "try /members, /resolve/<service>, /engage/<threat>, POST /threat, POST /send, /inbox, /tracks, /health" }));
  }
}).on("error", (err) => {
  log(`http server error: ${err.message}`);
  process.exit(1);
}).listen(HTTP_PORT);

// ---------- boot ----------
sock.bind(PORT, () => {
  log(`up — udp/${PORT} gossip, http/${HTTP_PORT} queries, service=${SERVICE ?? "none"}, device=${DEVICE}, profile=${PROFILE_NAME}${ADVERTISE ? `, advertising ${ADVERTISE}` : ""}${process.env.MESH_KEY ? ", encrypted (AES-256-GCM)" : ", PLAINTEXT"}`);
  tryJoin();
});
