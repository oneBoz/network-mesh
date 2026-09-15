/**
 * find-lighthouses.ts — which hosts on the LAN run a mesh lighthouse with OUR key?
 *
 *   set -a; . ../.env; set +a
 *   npx tsx scripts/find-lighthouses.ts 192.168.0.0/24 [--port 5001]
 *   npx tsx scripts/find-lighthouses.ts 192.168.0.14 192.168.0.20
 *
 * Sends one encrypted `join` as a throw-away node to every host and lists the
 * ones that answer with a join-ack. Use it to fill EXTRA_LIGHTHOUSES with a
 * LAN address instead of the router's public one (two devices behind one
 * router usually cannot hairpin). Side effect: the probe id "lh-probe" sits in
 * those lighthouses' registries for ~2 minutes and peers will briefly suspect
 * it — run it when idle, not during a demo.
 */
import { createSocket } from "node:dgram";
import { decode, encode } from "../src/protocol.js";
import type { Message } from "../src/protocol.js";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 5001);
const targets: string[] = [];
for (const a of argv.filter((x) => !x.startsWith("--") && x !== String(port))) {
  const m = a.match(/^(\d+\.\d+\.\d+)\.(\d+)\/24$/);
  if (m) for (let i = 1; i < 255; i++) targets.push(`${m[1]}.${i}`);
  else targets.push(a);
}
if (!targets.length) { console.error("usage: find-lighthouses.ts <ip | a.b.c.0/24> ... [--port 5001]"); process.exit(2); }
if (!process.env.MESH_KEY) { console.error("MESH_KEY is not set — `set -a; . ../.env; set +a` first"); process.exit(2); }

const sock = createSocket("udp4");
const found = new Map<string, number>();
sock.on("message", (buf, rinfo) => {
  const m = decode(buf) as (Message & { peers?: unknown[] }) | null;
  if (m && m.type === "join-ack") found.set(`${rinfo.address}:${rinfo.port}`, m.peers?.length ?? 0);
});
sock.bind(0, () => {
  const self = { id: "lh-probe", host: "0.0.0.0", port: sock.address().port, device: "probe" };
  const pkt = encode({ type: "join", node: self, inc: 0 } as unknown as Message);
  for (const h of targets) sock.send(pkt, port, h);
  setTimeout(() => {
    for (const [addr, n] of found) console.log(`lighthouse at ${addr} — answered with ${n} peer${n === 1 ? "" : "s"}`);
    if (!found.size) console.log(`no lighthouse with this key answered on udp/${port} at ${targets.length} address${targets.length === 1 ? "" : "es"}`);
    sock.close();
  }, 2000);
});
