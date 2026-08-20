import { useEffect, useRef, useState } from "react";
import { api, subscribe } from "./api";
import type { LogEvent, MeshState, ThreatAssignmentEvent } from "./types";
import { TopologyGraph } from "./TopologyGraph";
import { ConvergenceMatrix } from "./ConvergenceMatrix";
import { ProcPanel } from "./ProcPanel";
import { ResolvePanel } from "./ResolvePanel";
import { ThreatPanel } from "./ThreatPanel";
import { EventLog } from "./EventLog";

const MAX_LOG = 300;
const THREAT_HIGHLIGHT_MS = 12_000; // engagement rings fade after this

export function App() {
  const [state, setState] = useState<MeshState>({ ts: 0, procs: [], views: [], threats: [] });
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeThreat, setActiveThreat] = useState<ThreatAssignmentEvent | null>(null);
  const threatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Buffer log lines and flush on a short interval — 9 chatty processes
    // would otherwise trigger a full re-render (graph, matrix, ...) per line.
    const buffer: LogEvent[] = [];
    const flush = setInterval(() => {
      if (!buffer.length) return;
      const batch = buffer.splice(0);
      setEvents((prev) => [...prev, ...batch].slice(-MAX_LOG));
    }, 100);
    const unsubscribe = subscribe(
      (s) => setState(s),
      (e) => buffer.push(e),
      (up) => setConnected(up),
      (t) => {
        setActiveThreat(t);
        if (threatTimer.current) clearTimeout(threatTimer.current);
        threatTimer.current = setTimeout(() => setActiveThreat(null), THREAT_HIGHLIGHT_MS);
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

  return (
    <div className="app">
      <header>
        <h1>mesh-ts</h1>
        <div className="stats">
          <span><b>{liveNodes}</b>/{nodes.length} nodes</span>
          <span><b>{liveLh}</b>/{lighthouses.length} lighthouses</span>
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
          <ProcPanel state={state} onError={onError} />
          <ThreatPanel state={state} activeThreat={activeThreat} onError={onError} />
          <ResolvePanel state={state} />
          <EventLog events={events} />
        </div>
      </div>
    </div>
  );
}
