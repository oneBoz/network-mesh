/**
 * protocol.ts — shared wire format for the mesh.
 *
 * Messages are JSON over UDP. If the MESH_KEY environment variable is set,
 * every datagram is an authenticated-encryption frame:
 *
 *   0x02 | nonce (12 bytes, random) | AES-256-GCM( "<timestamp>\n<json>" ) | tag (16 bytes)
 *
 * The 256-bit frame key is HKDF-SHA256(MESH_KEY) bound to this frame format,
 * so rotating MESH_KEY rotates it; the version byte is authenticated as
 * associated data. Anyone without the key can neither read membership or
 * threat traffic nor forge or alter a packet (GCM's tag fails), and a
 * captured frame replayed later is dropped by the timestamp window. Every
 * rejection reports why, because on the wire a key mismatch looks exactly
 * like a dead peer. Without MESH_KEY the mesh speaks plaintext JSON (local
 * demos only). Everything here is node:crypto — no dependencies.
 *
 * What this does NOT give you: per-device identities. One shared key means
 * anyone holding it can claim any device name (PLAN.md Phase 6, Noise).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

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
  /** Human-readable name of the machine this node runs on (--device, default
   *  hostname). Purely informational: lets dashboards say WHERE a peer is. */
  device?: string;
}

/**
 * Application-level message carried over the mesh (the "data channel").
 * Flooded with a TTL and deduped by id like threat events; every node keeps
 * the ones addressed to it (or broadcast) in a small inbox. `kind` is free-form;
 * "gcs.signal" is special-cased: each node runs threat matchmaking on it so
 * every device shows the identical actions without any coordination.
 */
export interface MeshMessage {
  id: string;
  at: number; // sender's clock, ms epoch
  kind: string; // e.g. "gcs.signal", "chat"
  from: { node: string; device?: string; station?: string };
  to?: string; // node id for unicast; omitted = broadcast to every member
  body: Record<string, unknown>;
}

/** A membership rumor: "node <id> is <status>, as of incarnation <inc>". */
export interface Rumor {
  id: string;
  status: NodeStatus;
  inc: number;
}

export type Message =
  // `inc` (incarnation) lets a lighthouse tell "the same node, now at a new
  // address" (higher inc: it refuted suspicions after its NAT mapping changed)
  // from "a second machine claiming this id" (same or lower inc).
  | { type: "join"; node: PeerInfo; inc?: number } // answered by lighthouses AND any mesh node (peer-assisted join)
  // `from` is set when a mesh node (not a lighthouse) answers a join.
  | { type: "join-ack"; peers: PeerInfo[]; from?: PeerInfo }
  | { type: "announce"; node: PeerInfo; inc?: number } // periodic keepalive to lighthouses
  | { type: "ping"; seq: number; from: PeerInfo; rumors: Rumor[]; peers: PeerInfo[] }
  // "please probe `target` for me" — SWIM's indirect probe, sent when a direct
  // probe times out so one lossy path doesn't create a false suspicion.
  | { type: "ping-req"; seq: number; from: PeerInfo; target: PeerInfo; rumors: Rumor[]; peers: PeerInfo[] }
  // `relayed` marks an ack forwarded by a ping-req helper: the UDP source is
  // the helper, not `from`, so receivers must not rewrite `from` with rinfo.
  | { type: "ack"; seq: number; from: PeerInfo; relayed?: boolean; rumors: Rumor[]; peers: PeerInfo[] }
  // Application-level threat flood (TTL + dedupe-by-threatId). Deliberately
  // carries no rumors/peers piggyback and never touches membership state.
  | { type: "threat"; event: ThreatEvent; ttl: number; from: PeerInfo }
  // Application data channel (TTL + dedupe-by-id). Never touches membership.
  | { type: "msg"; msg: MeshMessage; ttl: number; from: PeerInfo }
  // NAT keepalive: a tiny no-op sent to every peer on another machine every
  // few seconds so the NAT mapping for that pair never idles out. Without it,
  // a peer's direct probe hits a closed mapping and the mesh falsely suspects
  // us even though we are fine. Receivers just refresh the sender's address.
  | { type: "keepalive"; from: PeerInfo };

/**
 * Hard cap on an encoded datagram. Anything over the path MTU (~1472 bytes of
 * UDP payload on the internet, less inside tunnels) is IP-fragmented, and many
 * NATs and cloud networks silently drop fragments — on loopback everything
 * works, on the real internet every probe fails. Gossip is incremental, so
 * shipping fewer peers/rumors per packet costs only a little convergence time.
 */
export const MAX_DATAGRAM = 1_350;

/** Drop items from `items` (from the front, or from the back when `fromBack`)
 *  until the message `build` makes from them encodes under MAX_DATAGRAM. Always
 *  keeps at least `min` items. */
export function trimToFit<T>(items: T[], build: (items: T[]) => Message, opts: { min?: number; fromBack?: boolean } = {}): T[] {
  const min = opts.min ?? 0;
  const arr = items.slice();
  while (arr.length > min && encode(build(arr)).length > MAX_DATAGRAM) {
    if (opts.fromBack) arr.pop(); else arr.shift();
  }
  return arr;
}

const FRAME_VERSION = 0x02; // AES-256-GCM frame; 0x7b ('{') is plaintext JSON
const NONCE_LEN = 12;
const TAG_LEN = 16;
/** Bytes an encrypted frame adds to the JSON: version + nonce + tag (+ the timestamp line, ~14). */
export const FRAME_OVERHEAD = 1 + NONCE_LEN + TAG_LEN;
const REPLAY_WINDOW_MS = 60_000; // frames older (or more future-dated) than this are dropped

/** The frame key for a shared secret: HKDF-SHA256, bound to this format. `null` for no secret (plaintext). */
export function deriveKey(secret: string): Buffer | null {
  if (!secret) return null;
  return Buffer.from(hkdfSync("sha256", secret, "network-mesh", "frame/aes-256-gcm/v2", 32));
}
const KEY = deriveKey(process.env.MESH_KEY ?? "");
/** True when this process encrypts (MESH_KEY set). */
export const ENCRYPTED = KEY !== null;

export function encodeWith(msg: Message, key: Buffer | null, now = Date.now()): Buffer {
  const body = JSON.stringify(msg);
  if (!key) return Buffer.from(body);
  const header = Buffer.from([FRAME_VERSION]);
  const nonce = randomBytes(NONCE_LEN); // 96-bit random nonce: fine for far fewer than 2^32 frames per key — rotate MESH_KEY now and then
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(`${now}\n${body}`, "utf8"), cipher.final()]);
  return Buffer.concat([header, nonce, ct, cipher.getAuthTag()]);
}
export const encode = (msg: Message): Buffer => encodeWith(msg, KEY);

/** `onDrop` (when given) is told WHY a frame was rejected — a key or clock
 *  mismatch is otherwise indistinguishable from a dead peer on the wire,
 *  which makes it nearly undebuggable in the field. */
export function decodeWith(buf: Buffer, key: Buffer | null, onDrop?: (reason: string) => void, now = Date.now()): Message | null {
  try {
    if (!buf.length) return null;
    if (buf[0] === 0x7b) { // '{' — plaintext JSON
      if (key) {
        onDrop?.("plaintext packet on an encrypted mesh — MESH_KEY mismatch?");
        return null;
      }
      return JSON.parse(buf.toString("utf8")) as Message;
    }
    if (!key) {
      onDrop?.("encrypted frame on a plaintext mesh — set MESH_KEY here too");
      return null;
    }
    if (buf[0] !== FRAME_VERSION) {
      onDrop?.(`unknown frame version 0x${buf[0].toString(16)} — peer on an older build (HMAC frames are gone)?`);
      return null;
    }
    if (buf.length < FRAME_OVERHEAD + 2) return null;
    const nonce = buf.subarray(1, 1 + NONCE_LEN);
    const ct = buf.subarray(1 + NONCE_LEN, buf.length - TAG_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
    decipher.setAAD(buf.subarray(0, 1));
    decipher.setAuthTag(tag);
    let text: string;
    try {
      text = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      onDrop?.("authentication failed — MESH_KEY mismatch, or the packet was altered");
      return null;
    }
    const nl = text.indexOf("\n");
    if (nl === -1) return null;
    if (Math.abs(now - Number(text.slice(0, nl))) > REPLAY_WINDOW_MS) {
      onDrop?.("timestamp outside the replay window — clock skew between machines, or a replayed packet?");
      return null;
    }
    return JSON.parse(text.slice(nl + 1)) as Message;
  } catch {
    return null;
  }
}
export const decode = (buf: Buffer, onDrop?: (reason: string) => void): Message | null => decodeWith(buf, KEY, onDrop);

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
