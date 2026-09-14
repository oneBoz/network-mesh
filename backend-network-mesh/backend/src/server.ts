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
import { ProcManager, ROOT } from "./procman.js";
import type { LogEvent, MeshState, NodeView, ProcSpec, ThreatAssignmentEvent, ThreatType } from "./types.js";

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

function broadcast(event: string, data: unknown): void {
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

let lastState: MeshState = { ts: Date.now(), procs: [], views: [], threats: recentThreats };

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
    };
    return { id, reachable: true, inc: body.self.inc, service: body.self.service, view: body.view };
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
  lastState = { ts: Date.now(), procs, views, threats: recentThreats };
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
  return { name: `lh-${p}`, kind: "lighthouse", port: p };
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
  const ids = ["maelstrom", "aegis", "smartfalcon", "edgefuse", "wisl"];
  const services = ids;
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
  console.log(`[backend] dashboard control plane on http://${HOST}:${PORT}`);
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
