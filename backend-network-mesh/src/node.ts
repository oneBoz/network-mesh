/**
 * node.ts — a regular mesh server.
 *
 * Responsibilities:
 *   - Join via any reachable lighthouse (tries each in order, retries forever).
 *   - Run the SWIM loop: every PROTOCOL_PERIOD, probe one random peer;
 *     timeout → suspect; suspicion timeout → dead; every message piggybacks
 *     rumors + peer addresses so knowledge spreads epidemically.
 *   - Refute false rumors about itself by bumping its incarnation number.
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
import { matchmake, SKILL_TABLE, THREAT_TYPES, toAssignment } from "./skills.js";

// ---------- config ----------
const args = parseArgs(process.argv.slice(2));
const ID = args.id ?? `node-${Math.random().toString(36).slice(2, 7)}`;
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

// Timers: loopback defaults, overridable per deployment via environment
// (e.g. ACK_TIMEOUT_MS=1500 SUSPECT_TIMEOUT_MS=10000 for lossy internet paths).
const envMs = (name: string, dflt: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
const PROTOCOL_PERIOD_MS = envMs("PROTOCOL_PERIOD_MS", 1_000); // one probe per second (jittered ±10% to avoid lockstep)
const ACK_TIMEOUT_MS = envMs("ACK_TIMEOUT_MS", 600); // direct probe considered failed after this
const INDIRECT_PROBES = 2; // helpers asked to probe on our behalf after a direct timeout
const INDIRECT_TIMEOUT_MS = envMs("INDIRECT_TIMEOUT_MS", 1_000); // extra wait for a relayed ack before suspecting (two internet hops each way when the helper is a relay)
const SUSPECT_TIMEOUT_MS = envMs("SUSPECT_TIMEOUT_MS", 5_000); // base suspect → dead window; scaled up with mesh size
const DEAD_PRUNE_MS = 30_000; // forget dead peers after this (bounds view + packet size)
const ANNOUNCE_INTERVAL_MS = 30_000; // keepalive to lighthouses; the reply doubles as an anti-entropy refresh
const REJOIN_MS = 10_000; // re-query lighthouses if our whole view has emptied
const MAX_PIGGYBACK = 24; // peer records offered per packet before size trimming (see gossipPayload)
const MAX_RUMORS_PER_PACKET = 8; // rumors are cheap but numerous; cap them so peer records still fit
const RESURRECT_EVERY_TICKS = 5; // how often to ping one known-dead peer (false-conviction healing)
const SAVE_PEERS_MS = 30_000; // persist known peer addresses for rejoin-after-restart
const KEEPALIVE_MS = envMs("KEEPALIVE_MS", 8_000); // NAT keepalive to every peer on another machine (typical UDP NAT idle timeout ≥ 30 s)
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

// Throttled: a key/clock mismatch arrives at packet rate, one line per 5s is enough.
let lastDropLog = 0;
function onDrop(reason: string): void {
  const now = Date.now();
  if (now - lastDropLog < 5_000) return;
  lastDropLog = now;
  log(`\x1b[33mdropping packets: ${reason}\x1b[0m`);
}

sock.on("message", (buf, rinfo) => {
  const msg = decode(buf, onDrop);
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
        sample(membership.allPeers().filter((p) => p.id !== joiner.id), MAX_PIGGYBACK),
        (ps) => ({ type: "join-ack", from: self, peers: ps }), { fromBack: true });
      send(joiner, { type: "join-ack", from: self, peers });
      log(`answered join from ${joiner.id} (peer-assisted)`);
      break;
    }
    case "join-ack": {
      const peers = Array.isArray(msg.peers) ? msg.peers : [];
      for (const p of peers) membership.upsertPeer(p);
      // A peer (not a lighthouse) answered — it told us who it is, and this
      // packet came straight from it, so trust the observed address.
      if (msg.from && typeof msg.from.id === "string" && msg.from.id) {
        membership.upsertPeer(observed(msg.from, rinfo), true);
      }
      if (!joined) {
        joined = true; // even an empty mesh counts as joined
        log(`joined mesh — learned ${peers.length} peers`);
      }
      // Subsequent join-acks are the 30s announce refresh (anti-entropy): the
      // upserts above quietly re-add any peers we pruned during a partition.
      break;
    }
    case "ping": {
      absorb(msg.rumors, msg.peers);
      membership.upsertPeer(msg.from, true);
      send(msg.from, withGossip({ type: "ack", seq: msg.seq, from: self }));
      break;
    }
    case "ping-req": {
      // Probe msg.target on msg.from's behalf; forward any ack we get.
      absorb(msg.rumors, msg.peers);
      membership.upsertPeer(msg.from, true);
      membership.upsertPeer(msg.target);
      // Prefer our own known address for the target over the requester's copy.
      const target = membership.allPeers().find((p) => p.id === msg.target.id) ?? msg.target;
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
      absorb(msg.rumors, msg.peers);
      membership.upsertPeer(msg.from, !msg.relayed);
      // Were we probing this node for someone else? Forward the good news.
      const proxy = pendingProxies.get(msg.seq);
      if (proxy && proxy.targetId === msg.from.id) {
        pendingProxies.delete(msg.seq);
        send(proxy.origin, withGossip({ type: "ack", seq: proxy.originSeq, from: msg.from, relayed: true }));
      }
      const pending = pendingAcks.get(msg.seq);
      // Only the node we actually probed may answer its probe.
      if (pending && pending.target === msg.from.id) {
        clearTimeout(pending.timer);
        pendingAcks.delete(msg.seq);
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
  seenMsgs.set(m.id, Date.now());

  const mine = !m.to || m.to === ID;
  let stored: StoredMessage | null = null;
  if (mine) {
    stored = { ...m, receivedAt: Date.now(), hop };
    if (m.kind === "gcs.signal" && typeof m.body.threat === "string" && THREAT_TYPES.includes(m.body.threat as ThreatType)) {
      stored.assignment = assignLocal({
        threatId: m.id, threat: m.body.threat as ThreatType, at: m.at, origin: m.from.node,
      });
      const a = stored.assignment;
      log(`\x1b[36mSIGNAL ${m.body.threat} from ${m.from.station ?? m.from.node}@${m.from.device ?? "?"} → primary=${a.primary ?? "NONE"} fallbacks=[${a.fallbacks.join(",")}]\x1b[0m`);
    } else {
      log(`\x1b[36mMSG ${m.kind} from ${m.from.station ?? m.from.node}@${m.from.device ?? "?"}${hop ? ` via ${hop}` : ""}\x1b[0m`);
    }
    inbox.push(stored);
    if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX);
  }

  if (ttl > 0) {
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
  return stored;
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

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

const VALID_STATUS = new Set(["alive", "suspect", "dead"]);

function absorb(rumors: Rumor[], peers: PeerInfo[]): void {
  if (Array.isArray(peers)) for (const p of peers) membership.upsertPeer(p);
  if (!Array.isArray(rumors)) return;
  for (const r of rumors) {
    // Skip structurally invalid rumors — they'd create phantom view entries.
    if (!r || typeof r.id !== "string" || !r.id || typeof r.inc !== "number" || !VALID_STATUS.has(r.status)) continue;
    if (membership.applyRumor(r) === "refute") {
      log(`\x1b[35mrefuting rumor that I am ${r.status} — incarnation now ${membership.selfInc}\x1b[0m`);
    }
  }
}

/** Peer addresses to piggyback: a random sample (so every address still
 *  spreads over time) capped to keep the datagram small, plus always us. */
function piggybackPeers(): PeerInfo[] {
  const all = membership.allPeers();
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, MAX_PIGGYBACK - 1).concat(self);
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
  return build(peers, fitRumors);
}

function send(to: { host: string; port: number }, msg: Message): void {
  sock.send(encode(msg), to.port, to.host, (err) => {
    if (err) log(`\x1b[31msend to ${to.host}:${to.port} failed: ${err.message}\x1b[0m`);
  });
}

// ---------- join + announce ----------
let joined = false;
let lastJoinAttempt = 0;

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
  for (const lh of LIGHTHOUSES) send(lh, { type: "join", node: self });
  for (const p of savedPeers.slice(0, 3)) send(p, { type: "join", node: self });
  setTimeout(tryJoin, 2_000); // keep retrying until someone answers
}

setInterval(() => {
  const lh = LIGHTHOUSES[Math.floor(Math.random() * LIGHTHOUSES.length)];
  if (lh) send(lh, { type: "announce", node: self });
}, ANNOUNCE_INTERVAL_MS);

// NAT keepalive: peers on other machines only (loopback/LAN needs none). A
// pair's mapping stays open as long as either side sends, so with 8 s here
// nobody's direct probe ever meets a closed mapping.
setInterval(() => {
  const keep: Message = { type: "keepalive", from: self };
  for (const p of membership.allPeers()) {
    if (p.device === DEVICE) continue;
    send(p, keep);
  }
}, KEEPALIVE_MS * (0.9 + Math.random() * 0.2));

// ---------- SWIM protocol loop ----------
let tick = 0;
function protocolTick(): void {
  scheduleTick(); // first, so no code path below can stall the loop
  tick++;
  membership.sweep(suspectTimeoutMs(), DEAD_PRUNE_MS);

  // Forget old threat ids so the dedupe map stays bounded.
  const threatCutoff = Date.now() - THREAT_SEEN_TTL_MS;
  for (const [id, ts] of seenThreats) {
    if (ts < threatCutoff) seenThreats.delete(id);
  }
  const msgCutoff = Date.now() - MSG_SEEN_TTL_MS;
  for (const [id, ts] of seenMsgs) {
    if (ts < msgCutoff) seenMsgs.delete(id);
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
  const s = ++seq;
  send(target, withGossip({ type: "ping", seq: s, from: self }));
  const timer = setTimeout(() => {
    // Direct probe failed. Before suspecting, ask a few peers to try their
    // path (SWIM's indirect probe) — one lossy link shouldn't convict a node.
    const helpers = candidates.filter((p) => p.id !== target.id);
    if (!helpers.length) {
      pendingAcks.delete(s);
      membership.markSuspect(target.id);
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
      membership.markSuspect(target.id);
    }, INDIRECT_TIMEOUT_MS);
    pendingAcks.set(s, { target: target.id, timer: indirectTimer });
  }, ACK_TIMEOUT_MS);
  pendingAcks.set(s, { target: target.id, timer });
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
  if (url === "/send" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
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
    res.end(JSON.stringify(
      { self: { ...self, host: selfHost, inc: membership.selfInc }, view: membership.snapshot() },
      null, 2
    ));
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
    res.end(JSON.stringify({ error: "try /members, /resolve/<service>, /engage/<threat>, POST /threat, POST /send, /inbox, /health" }));
  }
}).on("error", (err) => {
  log(`http server error: ${err.message}`);
  process.exit(1);
}).listen(HTTP_PORT);

// ---------- boot ----------
sock.bind(PORT, () => {
  log(`up — udp/${PORT} gossip, http/${HTTP_PORT} queries, service=${SERVICE ?? "none"}, device=${DEVICE}${ADVERTISE ? `, advertising ${ADVERTISE}` : ""}${process.env.MESH_KEY ? ", HMAC ON" : ""}`);
  tryJoin();
});
