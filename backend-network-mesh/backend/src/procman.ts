/**
 * procman.ts — spawns and tracks mesh processes as children of the backend.
 *
 * Every lighthouse/node is a real OS process running the untouched code in
 * src/ — the dashboard never simulates anything. Killing a process here is a
 * genuine crash as far as the mesh is concerned; the SWIM layer has to notice
 * it the hard way.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcSpec, ProcState } from "./types.js";

/** Repo root — cwd for children so `tsx` and src/ resolve. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
    const entry = spec.kind === "lighthouse" ? "src/lighthouse.ts" : "src/node.ts";
    const args = ["--import", "tsx", entry];
    if (spec.kind === "lighthouse") {
      args.push("--port", String(spec.port));
    } else {
      args.push("--id", spec.name, "--port", String(spec.port), "--http", String(spec.httpPort));
      if (spec.service) args.push("--service", spec.service);
      const lh = this.lighthouseAddrs();
      if (lh) args.push("--lighthouses", lh);
    }

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env, // passes MESH_KEY through if set
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
