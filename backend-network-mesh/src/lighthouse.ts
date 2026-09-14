/**
 * lighthouse.ts — the join broker.
 *
 * A lighthouse does exactly two things:
 *   1. Answers "join" with the list of peers it currently knows about.
 *   2. Records periodic "announce" keepalives so that list stays fresh.
 *
 * It is deliberately NOT in the gossip or data path: kill every lighthouse
 * and the existing mesh keeps running — only *new* joins fail. Run 3 of
 * these at 3 different sites and there is no single point of failure.
 *
 * Usage:
 *   npx tsx src/lighthouse.ts --port 5001
 */
import { createSocket } from "node:dgram";
import { makeLogger, parseArgs } from "./cli.js";
import type { PeerInfo } from "./protocol.js";
import { decode, encode, observed, trimToFit } from "./protocol.js";

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 5001);
const STALE_MS = 120_000; // forget peers not heard from in 2 minutes
const MAX_REGISTRY = 1_000; // refuse new registrations beyond this — bounds memory on a flood
const MAX_ACK_PEERS = 32; // peers per join-ack — keeps the datagram under the MTU
const ID_CONFLICT_MS = 45_000; // a *fresh* registration at another address blocks the same id

const log = makeLogger(`lighthouse:${PORT}`);

// A lighthouse on a public address is the mesh's front door. With MESH_KEY set,
// every packet must carry a valid HMAC — an unsigned or wrongly signed join is
// dropped and logged with its source address. REQUIRE_MESH_KEY=1 (set by the
// VPS compose files) refuses to start unsigned at all, so a forgotten key can
// never silently expose the mesh.
if (process.env.REQUIRE_MESH_KEY && !process.env.MESH_KEY) {
  log("REQUIRE_MESH_KEY is set but MESH_KEY is empty — refusing to run a public lighthouse unsigned");
  process.exit(1);
}

interface Registered {
  info: PeerInfo;
  lastSeen: number;
}

const registry = new Map<string, Registered>();
const sock = createSocket("udp4");

// An unhandled 'error' event (bind conflict, send failure) would kill the process.
sock.on("error", (err) => {
  log(`socket error: ${err.message}`);
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") process.exit(1);
});

// Throttled per source: a key/clock mismatch arrives at packet rate, one line
// per source per 5 s is enough — and the source address is what an operator
// needs to see ("who is knocking with the wrong key?").
const lastDropLog = new Map<string, number>();
let rejected = 0;
function onDrop(reason: string, from: string): void {
  rejected++;
  const now = Date.now();
  if (now - (lastDropLog.get(from) ?? 0) < 5_000) return;
  lastDropLog.set(from, now);
  log(`\x1b[33mREJECTED packet from ${from}: ${reason} (${rejected} rejected so far)\x1b[0m`);
}

sock.on("message", (buf, rinfo) => {
  const msg = decode(buf, (reason) => onDrop(reason, `${rinfo.address}:${rinfo.port}`));
  if (!msg) return; // unsigned/garbage — drop silently
  // decode() only guarantees valid JSON, not a well-formed Message: validate
  // the fields we use, and never let a throw escape (it would kill the process).
  try {
    if (msg.type !== "join" && msg.type !== "announce") return; // not our job — lighthouses stay out of the data path
    const node = msg.node as PeerInfo | undefined;
    if (!node || typeof node.id !== "string" || !node.id) return;
    if (!registry.has(node.id) && registry.size >= MAX_REGISTRY) {
      log(`registry full (${MAX_REGISTRY}) — ignoring ${msg.type} from ${rinfo.address}:${rinfo.port}`);
      return;
    }
    // Refuse a second machine claiming an id that is actively registered from
    // elsewhere — otherwise two nodes fight an incarnation war over one entry.
    // (A node re-registering from its own address, e.g. after a restart, is fine.)
    // Record the peer, using the *observed* source address (NAT-friendly:
    // this is the hole-punching trick — we tell peers the address we saw,
    // not the address the node thinks it has) — unless it explicitly
    // advertises a public host (see PeerInfo.advertise).
    const info: PeerInfo = observed(node, rinfo);
    const cur = registry.get(node.id);
    if (cur && (cur.info.host !== info.host || cur.info.port !== info.port)
        && Date.now() - cur.lastSeen < ID_CONFLICT_MS) {
      log(`id conflict: "${node.id}" from ${info.host}:${info.port} but actively registered at ${cur.info.host}:${cur.info.port} — ignoring`);
      return;
    }
    registry.set(info.id, { info, lastSeen: Date.now() });

    // Both join AND announce get a peer list back. Answering the periodic
    // announce turns the keepalive into an anti-entropy channel: after a
    // partition heals, each half re-learns the other's addresses within one
    // announce interval and gossip re-merges the views — without this, two
    // halves that convicted each other never exchange a packet again.
    // Sampled, then trimmed to one unfragmented datagram: the joiner learns the
    // rest through gossip and the next announce refresh.
    const peers = trimToFit(sample(freshPeers().filter((p) => p.id !== info.id), MAX_ACK_PEERS),
      (ps) => ({ type: "join-ack", peers: ps }), { fromBack: true });
    sock.send(encode({ type: "join-ack", peers }), rinfo.port, rinfo.address, (err) => {
      if (err) log(`join-ack to ${rinfo.address}:${rinfo.port} failed: ${err.message}`);
    });
    if (msg.type === "join") {
      log(`join: ${info.id} (${info.service ?? "no-svc"}) from ${rinfo.address}:${rinfo.port} → sent ${peers.length} peers`);
    }
  } catch (err) {
    log(`dropped malformed packet from ${rinfo.address}:${rinfo.port}: ${(err as Error).message}`);
  }
});

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

function freshPeers(): PeerInfo[] {
  const now = Date.now();
  const out: PeerInfo[] = [];
  for (const [id, r] of registry) {
    if (now - r.lastSeen > STALE_MS) registry.delete(id);
    else out.push(r.info);
  }
  return out;
}

setInterval(freshPeers, 30_000); // periodic prune even with no traffic

sock.bind(PORT, () => log(`lighthouse listening on udp/${PORT}${process.env.MESH_KEY ? " (HMAC signing ON — only holders of MESH_KEY can join)" : " (UNSIGNED — anyone can join; set MESH_KEY)"}`));
