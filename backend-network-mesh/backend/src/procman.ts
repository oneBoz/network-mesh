/**
 * procman.ts — spawns and tracks mesh processes as children of the backend.
 *
 * Every lighthouse/node is a real OS process running the untouched code in
 * src/ — the dashboard never simulates anything. Killing a process here is a
 * genuine crash as far as the mesh is concerned; the SWIM layer has to notice
 * it the hard way.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcSpec, ProcState } from "./types.js";

/** Name of this machine, stamped on every node we spawn (--device) and on
 *  every message they originate, so other devices can say where it came from. */
export const DEVICE = process.env.DEVICE_NAME?.trim() || hostname();
/** DEVICE reduced to a safe id fragment: "Dingyi's Mac" → "dingyi-s-mac". */
export const DEVICE_SLUG = DEVICE.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "device";
/** Public host of THIS machine (ADVERTISE env). Set when the dashboard itself
 *  runs on a host with a public IP and joins a lighthouse over loopback —
 *  otherwise that lighthouse would record its nodes as 127.0.0.1. */
export const ADVERTISE = process.env.ADVERTISE?.trim() || undefined;
/** Bearer token every child's HTTP query API demands (except /health). Fresh and random
 *  per control-plane start unless NODE_API_TOKEN is set — the node ports bind 0.0.0.0, so
 *  without this anyone who can reach them could inject threats or read views. */
export const NODE_API_TOKEN = process.env.NODE_API_TOKEN?.trim() || randomBytes(16).toString("hex");

/** True when this is the compiled build (dist/backend/src/*.js) rather than the
 *  sources run through tsx. Children are launched the same way as the parent:
 *  plain `node dist/src/<entry>.js` needs no loader and no esbuild service
 *  process, starts in a fraction of the time and uses about half the memory. */
export const COMPILED = import.meta.url.endsWith(".js");
/** Package root (backend-network-mesh/) — cwd for children so src/ or dist/ resolves. */
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = COMPILED ? join(HERE, "..", "..", "..") : join(HERE, "..", "..");

const ANSI = /\x1b\[[0-9;]*m/g; // node.ts colors its logs; the browser gets plain text

// `exited` is tracked via the child's exit event: a signal-killed process (the
// normal case here — kill() sends SIGTERM) keeps exitCode === null forever on
// Windows, so exitCode alone can't tell "running" from "killed".
interface Managed {
  spec: ProcSpec;
  child?: ChildProcess;
  exited: boolean;
}

function running(m: Managed | undefined): boolean {
  return !!m?.child && !m.exited && !m.child.killed;
}

export class ProcManager {
  private procs = new Map<string, Managed>();

  constructor(private onLog: (source: string, line: string) => void) {}

  /** Lighthouses on OTHER machines, from EXTRA_LIGHTHOUSES ("host:port,host:port").
   *  Every node spawned here joins them too, so a mesh booted by this
   *  dashboard merges with peers across the internet — the remote lighthouse
   *  records the NAT-mapped address it observes and hands it out to everyone. */
  extraLighthouses(): string[] {
    return (process.env.EXTRA_LIGHTHOUSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }

  /** All configured lighthouses (local children + external), as the --lighthouses argument for nodes. */
  lighthouseAddrs(): string {
    const local = [...this.procs.values()]
      .filter((m) => m.spec.kind === "lighthouse")
      .map((m) => `127.0.0.1:${m.spec.port}`);
    return local.concat(this.extraLighthouses()).join(",");
  }

  get(name: string): Managed | undefined {
    return this.procs.get(name);
  }

  list(): ProcState[] {
    return [...this.procs.values()].map((m) => ({
      ...m.spec,
      running: running(m),
      pid: m.child?.pid,
    }));
  }

  isRunning(name: string): boolean {
    return running(this.procs.get(name));
  }

  /** Register + launch. Re-registering an existing name restarts it with the new spec. */
  start(spec: ProcSpec): ProcState {
    if (running(this.procs.get(spec.name))) {
      throw new Error(`${spec.name} is already running`);
    }
    const entry = spec.kind === "lighthouse" ? "lighthouse" : "node";
    const args = COMPILED ? [`dist/src/${entry}.js`] : ["--import", "tsx", `src/${entry}.ts`];
    if (spec.kind === "lighthouse") {
      args.push("--port", String(spec.port));
      if (spec.httpPort) args.push("--http", String(spec.httpPort)); // loopback registry API for the dashboard
    } else {
      args.push("--id", spec.name, "--port", String(spec.port), "--http", String(spec.httpPort), "--device", DEVICE);
      if (ADVERTISE) args.push("--advertise", ADVERTISE);
      if (spec.service) args.push("--service", spec.service);
      const lh = this.lighthouseAddrs();
      if (lh) args.push("--lighthouses", lh);
    }

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, NODE_API_TOKEN }, // MESH_KEY passes through; the token gates the child's query API
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.wireOutput(spec.name, child);
    const managed: Managed = { spec, child, exited: false };
    child.on("exit", (code, signal) => {
      managed.exited = true;
      this.onLog(spec.name, `process exited (${signal ?? code})`);
    });

    this.procs.set(spec.name, managed);
    this.onLog("backend", `started ${spec.kind} ${spec.name} (pid ${child.pid})`);
    return { ...spec, running: true, pid: child.pid };
  }

  /** Hard-kill: simulates a server crash. The spec is kept so it can be revived. */
  kill(name: string): void {
    const m = this.procs.get(name);
    if (!m) throw new Error(`unknown process: ${name}`);
    if (running(m)) {
      m.child!.kill();
      this.onLog("backend", `killed ${name}`);
    }
  }

  /** Relaunch a previously killed process with its original spec. */
  revive(name: string): ProcState {
    const m = this.procs.get(name);
    if (!m) throw new Error(`unknown process: ${name}`);
    return this.start(m.spec);
  }

  /** Kill and forget entirely. */
  remove(name: string): void {
    const m = this.procs.get(name);
    if (!m) return;
    if (running(m)) m.child!.kill();
    this.procs.delete(name);
    this.onLog("backend", `removed ${name}`);
  }

  killAll(): void {
    for (const [, m] of this.procs) {
      if (running(m)) m.child!.kill();
    }
  }

  private wireOutput(name: string, child: ChildProcess): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).replace(ANSI, "").trimEnd();
          buf = buf.slice(nl + 1);
          if (line) this.onLog(name, line);
        }
      });
    }
  }
}
