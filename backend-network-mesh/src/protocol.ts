/**
 * protocol.ts — shared wire format for the mesh.
 *
 * Messages are JSON over UDP. If the MESH_KEY environment variable is set,
 * every message is framed as `<hex sig>\n<timestamp>\n<json>` where the sig
 * is HMAC-SHA256 over `<timestamp>\n<json>`; unsigned, invalid, or stale
 * (replayed) frames are silently dropped. That gives you cheap "only my
 * servers can speak on this mesh" protection with zero dependencies.
 * (It is NOT encryption — payloads are readable on the wire. Nebula/WireGuard
 * solve that layer for real deployments.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type NodeStatus = "alive" | "suspect" | "dead";

export type ThreatType = "missile" | "swarm" | "aircraft" | "emp";

/** Capability metadata carried inside PeerInfo — gossips with the peer record,
 *  so every node can matchmake threats against its local view. */
export interface Skills {
  threats: ThreatType[]; // threat types this system can engage
  layer: number; // engagement priority — lower engages first
  cost: number; // relative cost — tie-break within a layer, cheaper first
}

/** A discrete threat. pos/vel are reserved so kinematics (moving targets) can
 *  be added later without changing any message or endpoint shape. */
export interface ThreatEvent {
  threatId: string;
  threat: ThreatType;
  at: number; // injection time (ms epoch)
  origin?: string; // node id that first ingested it
  pos?: { x: number; y: number; z?: number };
  vel?: { x: number; y: number; z?: number };
}

/** Static identity + address of a mesh member. */
export interface PeerInfo {
  id: string;
  host: string;
  port: number; // UDP gossip port
  httpPort?: number; // query API port
  service?: string; // e.g. "api", "inventory"
  skills?: Skills; // defense capabilities (lighthouses and plain nodes have none)
  /** Explicit reachable host (public IP or DNS name), set with --advertise.
   *  Normally receivers trust the UDP source address they observe (which is
   *  what makes NAT hole punching work), but a node that talks to its own
   *  lighthouse over loopback — the usual layout on a VPS — would be recorded
   *  as 127.0.0.1 and handed out as such to the whole internet. `advertise`
   *  overrides the observed host (and keeps the node's own bind port). */
  advertise?: string;
}

/** A membership rumor: "node <id> is <status>, as of incarnation <inc>". */
export interface Rumor {
  id: string;
  status: NodeStatus;
  inc: number;
}

export type Message =
  | { type: "join"; node: PeerInfo } // answered by lighthouses AND any mesh node (peer-assisted join)
  // `from` is set when a mesh node (not a lighthouse) answers a join.
  | { type: "join-ack"; peers: PeerInfo[]; from?: PeerInfo }
  | { type: "announce"; node: PeerInfo } // periodic keepalive to lighthouses
  | { type: "ping"; seq: number; from: PeerInfo; rumors: Rumor[]; peers: PeerInfo[] }
  // "please probe `target` for me" — SWIM's indirect probe, sent when a direct
  // probe times out so one lossy path doesn't create a false suspicion.
  | { type: "ping-req"; seq: number; from: PeerInfo; target: PeerInfo; rumors: Rumor[]; peers: PeerInfo[] }
  // `relayed` marks an ack forwarded by a ping-req helper: the UDP source is
  // the helper, not `from`, so receivers must not rewrite `from` with rinfo.
  | { type: "ack"; seq: number; from: PeerInfo; relayed?: boolean; rumors: Rumor[]; peers: PeerInfo[] }
  // Application-level threat flood (TTL + dedupe-by-threatId). Deliberately
  // carries no rumors/peers piggyback and never touches membership state.
  | { type: "threat"; event: ThreatEvent; ttl: number; from: PeerInfo };

const KEY = process.env.MESH_KEY ?? "";
const REPLAY_WINDOW_MS = 60_000; // signed frames older (or more future-dated) than this are dropped

export function encode(msg: Message): Buffer {
  const body = JSON.stringify(msg);
  if (!KEY) return Buffer.from(body);
  const ts = String(Date.now());
  const sig = createHmac("sha256", KEY).update(`${ts}\n${body}`).digest("hex");
  return Buffer.from(`${sig}\n${ts}\n${body}`);
}

/** `onDrop` (when given) is told WHY a frame was rejected — a key or clock
 *  mismatch is otherwise indistinguishable from a dead peer on the wire,
 *  which makes it nearly undebuggable in the field. */
export function decode(buf: Buffer, onDrop?: (reason: string) => void): Message | null {
  try {
    const text = buf.toString("utf8");
    if (text.startsWith("{")) {
      if (KEY) {
        onDrop?.("unsigned packet on a signed mesh — MESH_KEY mismatch?");
        return null;
      }
      return JSON.parse(text) as Message;
    }
    if (!KEY) {
      onDrop?.("signed frame on an unsigned mesh — MESH_KEY mismatch?");
      return null;
    }
    const first = text.indexOf("\n");
    const second = text.indexOf("\n", first + 1);
    if (first === -1 || second === -1) return null;
    const ts = text.slice(first + 1, second);
    const body = text.slice(second + 1);
    const want = createHmac("sha256", KEY).update(`${ts}\n${body}`).digest();
    const got = Buffer.from(text.slice(0, first), "hex");
    if (got.length !== want.length || !timingSafeEqual(want, got)) {
      onDrop?.("bad HMAC signature — MESH_KEY mismatch?");
      return null;
    }
    if (Math.abs(Date.now() - Number(ts)) > REPLAY_WINDOW_MS) {
      onDrop?.("timestamp outside the replay window — clock skew between machines?");
      return null;
    }
    return JSON.parse(body) as Message;
  } catch {
    return null;
  }
}

/** The address to record for a peer whose packet just arrived from `rinfo`:
 *  its advertised host if it declared one, otherwise the observed source. */
export function observed(info: PeerInfo, rinfo: { address: string; port: number }): PeerInfo {
  if (typeof info.advertise === "string" && info.advertise) {
    return { ...info, host: info.advertise };
  }
  return { ...info, host: rinfo.address, port: rinfo.port };
}

/** Rumor precedence, straight from the SWIM paper:
 *  higher incarnation always wins; at equal incarnation, dead > suspect > alive. */
const RANK: Record<NodeStatus, number> = { alive: 0, suspect: 1, dead: 2 };

export function supersedes(a: Rumor, b: { status: NodeStatus; inc: number }): boolean {
  return a.inc > b.inc || (a.inc === b.inc && RANK[a.status] > RANK[b.status]);
}
