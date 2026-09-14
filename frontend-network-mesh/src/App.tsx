import { useEffect, useRef, useState } from "react";
import { api, subscribe } from "./api";
import type { InboxMessage, LogEvent, MeshState, ThreatAssignmentEvent, ThreatType } from "./types";
import { TopologyGraph } from "./TopologyGraph";
import { ConvergenceMatrix } from "./ConvergenceMatrix";
import { ProcPanel } from "./ProcPanel";
import { ResolvePanel } from "./ResolvePanel";
import { ThreatPanel } from "./ThreatPanel";
import { SignalsPanel } from "./SignalsPanel";
import { GcsView } from "./GcsView";
import { EventLog } from "./EventLog";
import { groupRemotes } from "./remotes";

const MAX_LOG = 300;
const THREAT_HIGHLIGHT_MS = 12_000; // engagement rings fade after this
const MODE_KEY = "mesh-mode";

/** Two operator modes on the same control plane:
 *  - command: the full picture (topology, convergence, fleet, log) plus the
 *    live feed of GCS signals and the actions the mesh took on them;
 *  - gcs: a Ground Control Station screen that sends signals and shows what
 *    every station (this one and the others, on any device) is seeing.
 *  The same device can run both — open two tabs. */
export type Mode = "command" | "gcs";

function initialMode(): Mode {
  const fromUrl = new URLSearchParams(location.search).get("mode");
  if (fromUrl === "gcs" || fromUrl === "command") return fromUrl;
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "gcs" || saved === "command") return saved;
  } catch { /* storage unavailable */ }
  return "command";
}

/** A GCS signal carries the same ranked answer a threat injection does — reuse
 *  the topology's engagement highlight for it. */
export function signalToThreat(m: InboxMessage): ThreatAssignmentEvent | null {
  if (m.kind !== "gcs.signal" || !m.assignment) return null;
  return {
    threatId: m.id,
    threat: m.body.threat as ThreatType,
    via: m.from.node,
    primary: m.assignment.primary,
    fallbacks: m.assignment.fallbacks,
    ranked: m.assignment.ranked,
    ts: m.at,
  };
}

const EMPTY: MeshState = {
  ts: 0, device: "", procs: [], views: [], threats: [], remotes: [], extraLighthouses: [], messages: [],
};

export function App() {
  const [state, setState] = useState<MeshState>(EMPTY);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeThreat, setActiveThreat] = useState<ThreatAssignmentEvent | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const threatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
    const url = new URL(location.href);
    url.searchParams.set("mode", mode);
    history.replaceState(null, "", url);
  }, [mode]);

  useEffect(() => {
    // Buffer log lines and flush on a short interval — 9 chatty processes
    // would otherwise trigger a full re-render (graph, matrix, ...) per line.
    const buffer: LogEvent[] = [];
    const flush = setInterval(() => {
      if (!buffer.length) return;
      const batch = buffer.splice(0);
      setEvents((prev) => [...prev, ...batch].slice(-MAX_LOG));
    }, 100);
    const highlight = (t: ThreatAssignmentEvent) => {
      setActiveThreat(t);
      if (threatTimer.current) clearTimeout(threatTimer.current);
      threatTimer.current = setTimeout(() => setActiveThreat(null), THREAT_HIGHLIGHT_MS);
    };
    const unsubscribe = subscribe(
      (s) => setState(s),
      (e) => buffer.push(e),
      (up) => setConnected(up),
      highlight,
      (m) => {
        const t = signalToThreat(m);
        if (t) highlight(t);
      }
    );
    return () => {
      clearInterval(flush);
      unsubscribe();
      if (threatTimer.current) clearTimeout(threatTimer.current);
    };
  }, []);

  const onError = (m: string) =>
    setEvents((prev) => [...prev, { source: "backend", line: `error: ${m}`, ts: Date.now() }].slice(-MAX_LOG));

  const nodes = state.procs.filter((p) => p.kind === "node");
  const liveNodes = nodes.filter((p) => p.running).length;
  const lighthouses = state.procs.filter((p) => p.kind === "lighthouse");
  const liveLh = lighthouses.filter((p) => p.running).length;
  const aliveRemotes = state.remotes.filter((r) => r.status === "alive").length;
  const remoteDevices = groupRemotes(state.remotes);
  const internet = state.remotes.length > 0 || state.extraLighthouses.length > 0;

  return (
    <div className={`app mode-${mode}`}>
      <header>
        <h1>mesh-ts</h1>
        <div className="mode-switch" role="tablist" aria-label="mode">
          <button role="tab" aria-selected={mode === "command"}
            className={mode === "command" ? "on" : undefined} onClick={() => setMode("command")}>
            ⌂ Command
          </button>
          <button role="tab" aria-selected={mode === "gcs"}
            className={mode === "gcs" ? "on" : undefined} onClick={() => setMode("gcs")}>
            ◎ GCS
          </button>
        </div>
        <div className="stats">
          {state.device && <span title="this machine (DEVICE_NAME)">on <b>{state.device}</b></span>}
          <span><b>{liveNodes}</b>/{nodes.length} nodes</span>
          <span><b>{liveLh}</b>/{lighthouses.length} lighthouses</span>
          {internet && (
            <span title={`members on other machines, reached over the internet via ${state.extraLighthouses.join(", ") || "a shared lighthouse"}`}>
              <b>{aliveRemotes}</b>/{state.remotes.length} remote on <b>{remoteDevices.length}</b> device{remoteDevices.length === 1 ? "" : "s"}
              {remoteDevices.length > 0 && <span className="muted"> ({remoteDevices.map((d) => d.device).join(", ")})</span>}
              {" "}<span className="remote-tag">internet</span>
            </span>
          )}
          <span style={{ color: connected ? "var(--alive)" : "var(--dead)" }}>
            {connected ? "● live" : "○ backend offline — run: npm run backend"}
          </span>
        </div>
        <div className="spacer" />
        <button className="primary" onClick={() => api.bootDemo().catch((e: Error) => onError(e.message))}>
          Boot demo mesh
        </button>
        <button className="danger" disabled={!liveNodes && !liveLh}
          onClick={() => api.stopAll().catch((e: Error) => onError(e.message))}>
          Stop all
        </button>
      </header>

      {mode === "gcs" ? (
        <GcsView state={state} activeThreat={activeThreat} onError={onError} />
      ) : (
        <div className="layout">
          <div className="col">
            <div className="panel graph-panel">
              <h2>Topology — consensus view</h2>
              <TopologyGraph state={state} activeThreat={activeThreat} />
            </div>
            <div className="panel">
              <h2>Convergence — who believes what</h2>
              <ConvergenceMatrix state={state} />
            </div>
          </div>
          <div className="col">
            <SignalsPanel state={state} />
            <ProcPanel state={state} onError={onError} />
            <ThreatPanel state={state} activeThreat={activeThreat} onError={onError} />
            <ResolvePanel state={state} />
            <EventLog events={events} />
          </div>
        </div>
      )}
    </div>
  );
}
