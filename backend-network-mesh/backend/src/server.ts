/**
 * server.ts — the dashboard backend (control plane).
 *
 * Node built-ins only, like the rest of the project. Three jobs:
 *   1. Process manager — spawn/crash/revive lighthouses and nodes on request
 *      (each is a real child process running the untouched src/ code).
 *   2. Poller — every second, ask each node's /members API for its view and
 *      merge the answers into one MeshState snapshot.
 *   3. Push — stream snapshots + process logs to the frontend over SSE.
 *
 * REST API (all JSON):
 *   GET    /api/state                  current MeshState
 *   GET    /api/events                 SSE stream: `state` + `log` events
 *   POST   /api/demo                   boot 3 lighthouses + 5 defense-system nodes
 *   POST   /api/stop-all               crash everything (specs kept for revive)
 *   POST   /api/quit                   stop everything AND exit the backend
 *   POST   /api/lighthouses            {port?} → spawn a lighthouse
 *   POST   /api/nodes                  {id?, service?} → spawn a node
 *   POST   /api/procs/<name>/kill      crash a process (spec kept)
 *   POST   /api/procs/<name>/start     revive a crashed process
 *   DELETE /api/procs/<name>           kill + forget
 *   GET    /api/resolve/<svc>?via=<id> service discovery through a live node
 *   POST   /api/threat                 {threat, via?} → inject a threat through a node
 *   GET    /api/geo                    location table (devices + defended assets)
 *   PUT    /api/geo/<id>               {kind, lat, lng, label?} → place/move; broadcast to the mesh
 *   DELETE /api/geo/<id>               remove an entry; broadcast
 *   POST   /api/signal                 {threat, station?, note?, via?} → a GCS signal:
 *                                      sent as a data-channel message through one
 *                                      node, flooded to every device on the mesh;
 *                                      each node matchmakes it independently
 *
 * Also serves the dashboard's production build statically if one exists —
 * by default from a sibling checkout of the frontend repo
 * (../network-mesh-frontend/dist), overridable with FRONTEND_DIST. During
 * development the Vite dev server proxies /api here instead.
 *
 * Usage: npx tsx backend/src/server.ts [--port 7070]
 */
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { ADVERTISE, DEVICE, DEVICE_SLUG, ProcManager, ROOT } from "./procman.js";
import { GeoStore } from "./geo.js";
import type { InboxMessage, LighthouseView, LogEvent, MeshState, NodeStatus, NodeView, ProcSpec, ProcState, RemoteMember, ThreatAssignmentEvent, ThreatType } from "./types.js";

const portFlag = process.argv.indexOf("--port");
const PORT = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : Number(process.env.PORT ?? 7070);
// Loopback by default: this API can spawn and kill processes. Inside a
// container the host cannot reach loopback, so compose sets HOST=0.0.0.0 and
// relies on the port mapping (bound to 127.0.0.1 on the host) for isolation.
const HOST = process.env.HOST ?? "127.0.0.1";
// 7070, not 7000: macOS Control Center (AirPlay Receiver) listens on *:7000 on
// every stock Mac and answers HTTP with a bare 403, which is very confusing.
const POLL_MS = 1_000;
const POLL_TIMEOUT_MS = 600;
// The dashboard lives in its own repo. Serve its production build when one
// exists; FRONTEND_DIST overrides the default sibling-checkout location.
const DIST = process.env.FRONTEND_DIST ?? join(ROOT, "..", "frontend-network-mesh", "dist");

// ---------- process manager + log fan-out ----------
const sseClients = new Set<ServerResponse>();
// Recent log lines, replayed to every new dashboard connection so a freshly
// opened tab (or Lighthouse mode) shows what just happened, not an empty box.
const MAX_LOG_HISTORY = 300;
const logHistory: LogEvent[] = [];

function broadcast(event: string, data: unknown): void {
  if (event === "log") {
    logHistory.push(data as LogEvent);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.splice(0, logHistory.length - MAX_LOG_HISTORY);
  }
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

const procman = new ProcManager((source, line) => {
  const e: LogEvent = { source, line, ts: Date.now() };
  console.log(`[${source}] ${line}`);
  broadcast("log", e);
});

// ---------- poller ----------
const MAX_THREAT_HISTORY = 20;
const recentThreats: ThreatAssignmentEvent[] = []; // most recent last, capped

// ---------- location table ----------
// Persisted under DATA_DIR (a named volume in Docker), broadcast as
// `geo.locations`, adopted from the mesh when a newer version arrives.
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, ".data");
const geo = new GeoStore(DATA_DIR, DEVICE);
const GEO_REBROADCAST_MS = 60_000;
const GEO_REQUEST_MS = 15_000;
let lastGeoRequest = 0;

/** Send a data-channel message through any live local node (fire and forget). */
async function sendViaLocalNode(kind: string, body: Record<string, unknown>): Promise<boolean> {
  const nodes = procman.list().filter((p) => p.kind === "node" && p.running && p.httpPort);
  const target = nodes[Math.floor(Math.random() * nodes.length)];
  if (!target) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${target.httpPort}/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, body }), signal: AbortSignal.timeout(1_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function broadcastGeo(): void {
  const t = geo.get();
  if (t.version === 0) return;
  void sendViaLocalNode("geo.locations", { table: t });
  broadcast("geo", t);
}

// Re-broadcast periodically so late joiners converge even if the edit-time
// broadcast was lost; ask the mesh for a table while we have none.
setInterval(() => {
  if (geo.get().version > 0) broadcastGeo();
  else if (Date.now() - lastGeoRequest > GEO_REQUEST_MS) {
    lastGeoRequest = Date.now();
    void sendViaLocalNode("geo.locations.request", { from: DEVICE });
  }
}, GEO_REQUEST_MS);

// ---------- data channel: merge every local node's inbox ----------
const MAX_MESSAGES = 100;
const messages: InboxMessage[] = []; // most recent last
const messageIndex = new Map<string, InboxMessage>();
const inboxCursor = new Map<string, number>(); // node → last receivedAt fetched

interface NodeInboxEntry {
  id: string; at: number; kind: string; from: InboxMessage["from"]; to?: string;
  body: Record<string, unknown>; assignment?: InboxMessage["assignment"]; receivedAt: number;
}

async function pollInbox(node: string, httpPort: number): Promise<void> {
  try {
    const after = inboxCursor.get(node) ?? 0;
    const r = await fetch(`http://127.0.0.1:${httpPort}/inbox?after=${after}`, {
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    const body = (await r.json()) as { messages: NodeInboxEntry[] };
    for (const m of body.messages) {
      inboxCursor.set(node, Math.max(inboxCursor.get(node) ?? 0, m.receivedAt));
      const existing = messageIndex.get(m.id);
      if (!existing) {
        const housekeeping = m.kind === "geo.locations" || m.kind === "geo.locations.request";
        if (housekeeping) {
          messageIndex.set(m.id, { id: m.id, at: m.at, kind: m.kind, from: m.from, body: {}, receivedAt: m.receivedAt, seenBy: [node], agree: 1, consistent: true });
          if (m.kind === "geo.locations" && geo.adopt((m.body as { table?: unknown }).table)) {
            broadcast("geo", geo.get());
            broadcast("log", { source: "backend", line: `adopted location table v${geo.get().version} from ${m.from.device ?? m.from.node}`, ts: Date.now() } satisfies LogEvent);
          }
          if (m.kind === "geo.locations.request" && geo.get().version > 0 && m.from.device !== DEVICE) broadcastGeo();
          continue;
        }
        const merged: InboxMessage = {
          id: m.id, at: m.at, kind: m.kind, from: m.from, to: m.to, body: m.body,
          assignment: m.assignment, receivedAt: m.receivedAt, seenBy: [node], agree: 1, consistent: true,
        };
        messageIndex.set(m.id, merged);
        messages.push(merged);
        while (messages.length > MAX_MESSAGES) messageIndex.delete(messages.shift()!.id);
        broadcast("message", merged);
        if (m.kind === "gcs.signal") {
          const a = m.assignment;
          broadcast("log", {
            source: "backend",
            line: `signal ${String(m.body.threat)} from ${m.from.station ?? m.from.node}@${m.from.device ?? "?"} → primary ${a?.primary ?? "NONE (leaked!)"}${a?.fallbacks.length ? `, fallbacks ${a.fallbacks.join(" → ")}` : ""}`,
            ts: Date.now(),
          } satisfies LogEvent);
        }
      } else if (!existing.seenBy.includes(node)) {
        existing.seenBy.push(node);
        // Every node should have decided the same thing — the "one entity" check.
        // A node whose view had not converged at that instant answers differently.
        const same = !m.assignment || !existing.assignment
          || (m.assignment.primary === existing.assignment.primary
            && m.assignment.fallbacks.join() === existing.assignment.fallbacks.join());
        if (same) existing.agree++;
        existing.consistent = existing.agree === existing.seenBy.length;
      }
    }
  } catch {
    // unreachable node: its inbox is re-fetched from the same cursor next round
  }
}

let lastState: MeshState = {
  ts: Date.now(), device: DEVICE, procs: [], views: [], threats: recentThreats,
  remotes: [], extraLighthouses: procman.extraLighthouses(), messages, geo: geo.get(), lighthouses: [],
};

const RANK: Record<NodeStatus, number> = { alive: 0, suspect: 1, dead: 2 };

/** Members that appear in local nodes' views but are not our processes: nodes
 *  on other machines that joined through a shared lighthouse. Status is the
 *  majority opinion of the local observers (ties broken pessimistically), the
 *  same rule the frontend uses for consensus colouring. */
function deriveRemotes(procs: ProcState[], views: NodeView[]): RemoteMember[] {
  const local = new Set(procs.map((p) => p.name));
  const acc = new Map<string, RemoteMember>();
  for (const v of views) {
    if (!v.reachable) continue;
    for (const [id, e] of Object.entries(v.view)) {
      if (local.has(id) || !e.info) continue;
      let r = acc.get(id);
      if (!r) {
        r = {
          id, device: e.info.device, host: e.info.host, port: e.info.port, httpPort: e.info.httpPort,
          service: e.info.service, skills: e.info.skills,
          status: e.status, inc: e.inc, since: e.since, observers: 0,
          votes: { alive: 0, suspect: 0, dead: 0 },
        };
        acc.set(id, r);
      }
      r.observers++;
      r.votes[e.status]++;
      // "relay" only if every observer that has an opinion says relay.
      const p = v.paths?.[id];
      if (p) r.path = r.path === undefined ? p : (r.path === "relay" && p === "relay" ? "relay" : "direct");
      if (e.inc > r.inc) r.inc = e.inc;
      if (e.since < r.since) r.since = e.since;
      // Prefer the address held by an observer that currently reaches it.
      if (e.status === "alive") { r.host = e.info.host; r.port = e.info.port; }
      if (!r.device && e.info.device) r.device = e.info.device;
    }
  }
  for (const r of acc.values()) {
    r.status = (Object.keys(r.votes) as NodeStatus[]).reduce((best, s) =>
      r.votes[s] > r.votes[best] || (r.votes[s] === r.votes[best] && RANK[s] > RANK[best]) ? s : best);
  }
  return [...acc.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function pollNode(id: string, httpPort: number): Promise<NodeView> {
  try {
    // AbortSignal.timeout covers the body read too — a node that sends headers
    // then stalls mid-body would otherwise hang this poll slot forever.
    const r = await fetch(`http://127.0.0.1:${httpPort}/members`, {
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    const body = (await r.json()) as {
      self: { id: string; inc: number; service?: string };
      view: NodeView["view"];
      paths?: NodeView["paths"];
    };
    return { id, reachable: true, inc: body.self.inc, service: body.self.service, view: body.view, paths: body.paths };
  } catch {
    return { id, reachable: false, inc: 0, view: {} };
  }
}

async function poll(): Promise<void> {
  const procs = procman.list();
  const nodes = procs.filter((p) => p.kind === "node");
  const views = await Promise.all(
    nodes.map((n) =>
      n.running && n.httpPort
        ? pollNode(n.name, n.httpPort)
        : Promise.resolve<NodeView>({ id: n.name, reachable: false, inc: 0, service: n.service, view: {} })
    )
  );
  await Promise.all(nodes.filter((n) => n.running && n.httpPort).map((n) => pollInbox(n.name, n.httpPort!)));
  const lighthouses = await Promise.all(procs.filter((p) => p.kind === "lighthouse").map(pollLighthouse));
  lastState = {
    ts: Date.now(), device: DEVICE, procs, views, threats: recentThreats,
    remotes: deriveRemotes(procs, views), extraLighthouses: procman.extraLighthouses(), messages, geo: geo.get(),
    lighthouses,
  };
  broadcast("state", lastState);
}

setInterval(poll, POLL_MS);

// ---------- port / name allocation ----------
// Windows reserves whole port ranges (Hyper-V/WinNAT exclusions), so a port
// being unclaimed by *us* isn't enough — probe that the OS will actually let
// a process bind it before handing it to a child.
function tcpBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createTcpServer();
    s.once("error", () => resolve(false));
    s.listen(port, "0.0.0.0", () => s.close(() => resolve(true)));
  });
}

function udpBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    s.once("error", () => resolve(false));
    s.bind(port, () => s.close(() => resolve(true)));
  });
}

async function nextFree(
  taken: number[],
  from: number,
  bindable: (p: number) => Promise<boolean>
): Promise<number> {
  for (let p = from; p < from + 500; p++) {
    if (!taken.includes(p) && (await bindable(p))) return p;
  }
  throw new Error(`no free port found from ${from}`);
}

// Port probing + spawning isn't atomic, so two concurrent requests could be
// handed the same port. Serialize every allocate-and-start through one chain.
let allocChain: Promise<unknown> = Promise.resolve();
function withAllocLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = allocChain.then(fn, fn);
  allocChain = run.catch(() => undefined);
  return run;
}

async function allocNodeSpec(id: string | undefined, service: string | undefined): Promise<ProcSpec> {
  if (!procman.lighthouseAddrs()) {
    throw new Error("add a lighthouse first — a node needs one to join the mesh");
  }
  const procs = procman.list();
  const udp = await nextFree(procs.map((p) => p.port), 4001, udpBindable);
  const http = await nextFree(procs.map((p) => p.httpPort ?? 0), 8001, tcpBindable);
  let name = id?.trim();
  if (!name) {
    let n = 1;
    while (procs.some((p) => p.name === `N${n}`)) n++;
    name = `N${n}`;
  }
  if (procs.some((p) => p.name === name)) throw new Error(`name ${name} already exists`);
  return { name, kind: "node", port: udp, httpPort: http, service: service?.trim() || undefined };
}

async function allocLighthouseSpec(port: number | undefined): Promise<ProcSpec> {
  const procs = procman.list();
  const p = port ?? (await nextFree(procs.map((x) => x.port), 5001, udpBindable));
  if (procs.some((x) => x.port === p)) throw new Error(`port ${p} already in use`);
  // Loopback registry API so Lighthouse mode can show who is registered.
  const http = await nextFree(procs.map((x) => x.httpPort ?? 0), 9001, tcpBindable);
  return { name: `lh-${p}`, kind: "lighthouse", port: p, httpPort: http };
}

async function pollLighthouse(p: ProcState): Promise<LighthouseView> {
  const base: LighthouseView = { name: p.name, port: p.port, reachable: false, signing: false, registered: 0, rejected: 0, joins: 0, uptimeMs: 0, staleMs: 0, entries: [] };
  if (!p.running || !p.httpPort) return base;
  try {
    const r = await fetch(`http://127.0.0.1:${p.httpPort}/registry`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    const body = (await r.json()) as Omit<LighthouseView, "name" | "reachable">;
    return { ...base, ...body, name: p.name, reachable: true };
  } catch {
    return base;
  }
}

async function bootDemo(): Promise<void> {
  // Defense-network demo fleet — one server site per defense system:
  //   maelstrom    Defense Layer 1 — MAELSTROM Command (anti-swarm): takes down
  //                higher-level threats using high-speed propulsion
  //   aegis        Defense Layer 2 — AEGIS: close-combat interception
  //   smartfalcon  Defense Layer 3 — SmartFalcon: same role as AEGIS; steps in
  //                if AEGIS fails
  //   edgefuse     Defense Layer 4 — EdgeFuse (leader: Lee Jinho): on-sensor
  //                fused detection for counter-swarm; goes for the kill if
  //                layers 2 and 3 fail
  //   wisl         EMP Defense — WISL (anti-swarm): EMP jamming / e-warfare
  //                specialist; cheaper to send for EMF threats than Layer 1
  //                missiles
  const services = ["maelstrom", "aegis", "smartfalcon", "edgefuse", "wisl"];
  // Ids must be unique mesh-wide. When this fleet joins lighthouses on other
  // machines, every device booting the demo would otherwise register the same
  // five ids and fight over them — so suffix them with this device's name.
  // Service names stay as they are: skills, matchmaking and display keys use them.
  // (Also when this host advertises a public address: it is, by definition, one of several.)
  const multiDevice = procman.extraLighthouses().length > 0 || !!ADVERTISE;
  const ids = multiDevice ? services.map((s) => `${s}-${DEVICE_SLUG}`) : services;
  for (const port of [5001, 5002, 5003]) {
    const name = `lh-${port}`;
    if (!procman.get(name)) procman.start(await allocLighthouseSpec(port));
    else if (!procman.isRunning(name)) procman.revive(name);
  }
  for (let i = 0; i < ids.length; i++) {
    if (!procman.get(ids[i])) procman.start(await allocNodeSpec(ids[i], services[i]));
    else if (!procman.isRunning(ids[i])) procman.revive(ids[i]);
  }
}

// ---------- helpers ----------
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".map": "application/json", ".woff": "font/woff", ".woff2": "font/woff2",
  ".txt": "text/plain",
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  const rel = normalize(urlPath === "/" ? "index.html" : urlPath.slice(1));
  if (rel.startsWith("..")) return false;
  const file = join(DIST, rel);
  try {
    if (!(await stat(file)).isFile()) return false;
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
    return true;
  } catch {
    return false;
  }
}

// ---------- HTTP server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (path === "/api/state" && method === "GET") {
      return json(res, 200, lastState);
    }

    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const e of logHistory) res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(lastState)}\n\n`);
      sseClients.add(res);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return;
    }

    if (path === "/api/demo" && method === "POST") {
      await withAllocLock(bootDemo);
      return json(res, 200, { ok: true });
    }

    // Crash every process but keep the specs — the whole fleet can be revived.
    if (path === "/api/stop-all" && method === "POST") {
      procman.killAll();
      return json(res, 200, { ok: true });
    }

    // Shut down the backend itself (and its children) — Ctrl+C for scripts,
    // and the only reliable way to stop everything when the terminal is gone.
    if (path === "/api/quit" && method === "POST") {
      procman.killAll();
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (path === "/api/lighthouses" && method === "POST") {
      const body = await readJson(req);
      const state = await withAllocLock(async () =>
        procman.start(await allocLighthouseSpec(body.port ? Number(body.port) : undefined))
      );
      return json(res, 201, state);
    }

    if (path === "/api/nodes" && method === "POST") {
      const body = await readJson(req);
      const state = await withAllocLock(async () =>
        procman.start(
          await allocNodeSpec(
            typeof body.id === "string" ? body.id : undefined,
            typeof body.service === "string" ? body.service : undefined
          )
        )
      );
      return json(res, 201, state);
    }

    const procMatch = path.match(/^\/api\/procs\/([^/]+)(?:\/(kill|start))?$/);
    if (procMatch) {
      const [, name, action] = procMatch;
      if (method === "POST" && action === "kill") {
        procman.kill(name);
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && action === "start") {
        return json(res, 200, procman.revive(name));
      }
      if (method === "DELETE" && !action) {
        procman.remove(name);
        return json(res, 200, { ok: true });
      }
    }

    // Location table: read, place/move, remove. Every edit is persisted here
    // and broadcast to the mesh; other devices adopt it by version.
    if (path === "/api/geo" && method === "GET") return json(res, 200, geo.get());
    const geoMatch = path.match(/^\/api\/geo\/([^/]+)$/);
    if (geoMatch && (method === "PUT" || method === "DELETE")) {
      const id = decodeURIComponent(geoMatch[1]);
      if (method === "DELETE") {
        geo.remove(id);
        broadcastGeo();
        return json(res, 200, geo.get());
      }
      const body = await readJson(req);
      const entry = { kind: body.kind, lat: Number(body.lat), lng: Number(body.lng), label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined };
      if (!GeoStore.validEntry(entry)) return json(res, 400, { error: "entry needs kind (device|asset), lat, lng" });
      geo.set(id, entry);
      broadcastGeo();
      broadcast("log", { source: "backend", line: `placed ${entry.kind} ${entry.label ?? id} at ${entry.lat.toFixed(4)}, ${entry.lng.toFixed(4)} (table v${geo.get().version})`, ts: Date.now() } satisfies LogEvent);
      return json(res, 200, geo.get());
    }

    // GCS signal: a data-channel message originated by one local node and
    // flooded to every member (relays first), which each matchmake on their own.
    if (path === "/api/signal" && method === "POST") {
      const body = await readJson(req);
      const candidates = procman
        .list()
        .filter((p) => p.kind === "node" && p.running && p.httpPort && (!body.via || p.name === body.via));
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (!target) return json(res, 503, { error: "no live node to send through" });
      const station = typeof body.station === "string" && body.station.trim() ? body.station.trim() : `GCS-${DEVICE}`;
      const payload: Record<string, unknown> = { threat: body.threat };
      if (typeof body.note === "string" && body.note.trim()) payload.note = body.note.trim();
      if (body.pos && typeof body.pos === "object") payload.pos = body.pos;
      const r = await fetch(`http://127.0.0.1:${target.httpPort}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "gcs.signal", station, body: payload }),
        signal: AbortSignal.timeout(1_000),
      });
      const answer = (await r.json()) as Record<string, unknown>;
      if (!r.ok) return json(res, r.status, answer);
      return json(res, 200, { via: target.name, ...answer });
    }

    // Inject a threat through one node's /threat endpoint (chosen or random).
    // That node matchmakes from its own view and floods the event to the rest —
    // every node then logs the identical assignment ("one entity" in action).
    if (path === "/api/threat" && method === "POST") {
      const body = await readJson(req);
      const threat = body.threat as ThreatType | undefined;
      const candidates = procman
        .list()
        .filter((p) => p.kind === "node" && p.running && p.httpPort && (!body.via || p.name === body.via));
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (!target) return json(res, 503, { error: "no live node to ask" });
      const r = await fetch(`http://127.0.0.1:${target.httpPort}/threat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threat }),
        signal: AbortSignal.timeout(1_000), // a wedged node must not hang the dashboard
      });
      const answer = (await r.json()) as Record<string, unknown>;
      if (!r.ok) return json(res, r.status, answer);
      const evt: ThreatAssignmentEvent = {
        threatId: String(answer.threatId),
        threat: answer.threat as ThreatType,
        via: target.name,
        primary: typeof answer.primary === "string" ? answer.primary : undefined,
        fallbacks: Array.isArray(answer.fallbacks) ? (answer.fallbacks as string[]) : [],
        ranked: Array.isArray(answer.ranked) ? (answer.ranked as ThreatAssignmentEvent["ranked"]) : [],
        ts: Date.now(),
      };
      recentThreats.push(evt);
      if (recentThreats.length > MAX_THREAT_HISTORY) recentThreats.shift();
      broadcast("threat", evt);
      broadcast("log", {
        source: "backend",
        line: `threat ${evt.threat} via ${evt.via} → primary ${evt.primary ?? "NONE (leaked!)"}${evt.fallbacks.length ? `, fallbacks ${evt.fallbacks.join(" → ")}` : ""}`,
        ts: evt.ts,
      } satisfies LogEvent);
      return json(res, 200, evt);
    }

    const resolveMatch = path.match(/^\/api\/resolve\/([^/]+)$/);
    if (resolveMatch && method === "GET") {
      const via = url.searchParams.get("via");
      const candidates = procman
        .list()
        .filter((p) => p.kind === "node" && p.running && p.httpPort && (!via || p.name === via));
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (!target) return json(res, 503, { error: "no live node to ask" });
      const r = await fetch(`http://127.0.0.1:${target.httpPort}/resolve/${resolveMatch[1]}`, {
        signal: AbortSignal.timeout(1_000), // a wedged node must not hang the dashboard
      });
      const body = await r.json();
      return json(res, r.status, { via: target.name, ...(body as object) });
    }

    if (!path.startsWith("/api/") && method === "GET") {
      if (await serveStatic(res, path)) return;
      // SPA fallback: extensionless paths (client-side routes) get index.html.
      if (extname(path) === "" && (await serveStatic(res, "/"))) return;
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[backend] dashboard control plane on http://${HOST}:${PORT} (device: ${DEVICE}${ADVERTISE ? `, advertising ${ADVERTISE}` : ""})`);
  const extra = procman.extraLighthouses();
  if (extra.length) console.log(`[backend] nodes will also join external lighthouses: ${extra.join(", ")}`);
  console.log(`[backend] POST /api/demo to boot the standard 3-lighthouse / 5-system defense mesh`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    procman.killAll();
    process.exit(0);
  });
}
