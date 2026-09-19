import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe } from "./api";
import type { InboxMessage, LogEvent, MeshState, ThreatAssignmentEvent, ThreatType } from "./types";
import { ConvergenceMatrix } from "./ConvergenceMatrix";
import { ProcPanel } from "./ProcPanel";
import { ResolvePanel } from "./ResolvePanel";
import { ThreatPanel } from "./ThreatPanel";
import { SignalsPanel } from "./SignalsPanel";
import { GcsView } from "./GcsView";
import { EventLog } from "./EventLog";
import { LighthouseModeView } from "./LighthouseView";
import { TimelinePanel } from "./Engagement";
import { StatusStrip } from "./StatusStrip";
import { SituationPanel } from "./Situation";
import { ConfirmSheet, Disclosure, Pill } from "./ui";
import type { ConfirmRequest } from "./ui";

const MAX_LOG = 300;
const MAX_MESSAGES = 100; // mirrors the control plane's cap
const THREAT_HIGHLIGHT_MS = 12_000; // engagement rings fade after this
const MODE_KEY = "mesh-mode";
let logSeq = 0; // stable keys for log rows: the list is a sliding window, so an index would shift every flush

/** Messages arrive as their own SSE events — once when first seen and again when
 *  more local nodes report them — and never inside a `state` patch. */
function upsertMessage(list: InboxMessage[], m: InboxMessage): InboxMessage[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) { const next = list.slice(); next[i] = m; return next; }
  return [...list, m].slice(-MAX_MESSAGES);
}

/** Three operator modes on the same control plane:
 *  - command: the full picture — status strip, situation (map / topology) with the
 *    engagement timeline, fleet, threat injection, GCS signals, then diagnostics folded away;
 *  - gcs: a Ground Control Station screen that sends signals and shows what
 *    every station (this one and the others, on any device) is seeing;
 *  - lighthouse: what this device's lighthouses see.
 *  The same device can run all three — open several tabs. */
export type Mode = "command" | "gcs" | "lighthouse";
const MODE_LABEL: Record<Mode, string> = { command: "Command", gcs: "GCS", lighthouse: "Lighthouse" };

function initialMode(): Mode {
  const fromUrl = new URLSearchParams(location.search).get("mode");
  if (fromUrl === "gcs" || fromUrl === "command" || fromUrl === "lighthouse") return fromUrl;
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "gcs" || saved === "command" || saved === "lighthouse") return saved;
  } catch { /* storage unavailable */ }
  return "command";
}

/** A GCS signal carries the same ranked answer a threat injection does — reuse
 *  the topology's engagement highlight for it. */
export function signalToThreat(m: InboxMessage): ThreatAssignmentEvent | null {
  if ((m.kind !== "gcs.signal" && m.kind !== "track.detected") || !m.assignment) return null;
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
  geo: { version: 0, updatedBy: "", updatedAt: 0, entries: {} },
  lighthouses: [], tracks: [], sims: [],
};

export function App() {
  const [state, setState] = useState<MeshState>(EMPTY);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeThreat, setActiveThreat] = useState<ThreatAssignmentEvent | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const threatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirm = useCallback((req: ConfirmRequest) => setConfirmReq(req), []);
  const closeConfirm = useCallback(() => setConfirmReq(null), []);

  useEffect(() => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
    const url = new URL(location.href);
    url.searchParams.set("mode", mode);
    history.replaceState(null, "", url);
    document.title = `mesh-ts · ${MODE_LABEL[mode]}`;
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
      // Full snapshot on connect, then patches: slices absent from a patch keep their identity.
      (patch) => setState((prev) => ({ ...prev, ...patch })),
      (e) => buffer.push({ ...e, id: ++logSeq }),
      (up) => setConnected(up),
      highlight,
      (m) => {
        setState((prev) => ({ ...prev, messages: upsertMessage(prev.messages, m) }));
        const t = signalToThreat(m);
        if (t) highlight(t);
        // A neutralised (or lost) target stops glowing on the topology.
        if ((m.kind === "track.neutralised" || m.kind === "track.lost" || m.kind === "track.impact") && typeof m.body.trackId === "string") {
          const id = m.body.trackId;
          setActiveThreat((cur) => (cur && cur.threatId === id ? null : cur));
        }
      },
      (g) => setState((prev) => (g.version > prev.geo.version ? { ...prev, geo: g } : prev))
    );
    return () => {
      clearInterval(flush);
      unsubscribe();
      if (threatTimer.current) clearTimeout(threatTimer.current);
    };
  }, []);

  const onError = (m: string) =>
    setEvents((prev) => [...prev, { id: ++logSeq, source: "backend", line: `error: ${m}`, ts: Date.now() }].slice(-MAX_LOG));

  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running).length;
  const liveLh = state.procs.filter((p) => p.kind === "lighthouse" && p.running).length;
  const observers = state.views.filter((v) => v.reachable).length;
  const subjects = new Set([...state.procs.filter((p) => p.kind === "node").map((p) => p.name), ...state.remotes.map((r) => r.id)]).size;

  const stopAll = () => confirm({
    title: "Stop the whole fleet?",
    body: "Every lighthouse and node on this device is killed at once. Their specs are kept, so Boot demo mesh brings them back; scenario launches still pending are dropped.",
    confirmLabel: "Stop all",
    destructive: true,
    onConfirm: () => { api.stopAll().catch((e: Error) => onError(e.message)); },
  });

  return (
    <div className={`app mode-${mode}`}>
      <header className="bar">
        <h1 className="wordmark">mesh-ts<small>{MODE_LABEL[mode]}{state.device ? ` · ${state.device}` : ""}</small></h1>
        <div className="seg" role="tablist" aria-label="Mode">
          {(["command", "gcs", "lighthouse"] as Mode[]).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              title={m === "lighthouse" ? "What this device's lighthouses see: registrations, moves, rejected packets" : m === "gcs" ? "Ground control station: report threats and act on targets" : "The full picture"}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <Pill tone={connected ? "ok" : "bad"} dot>{connected ? "Live" : "Backend offline — run: npm run backend"}</Pill>
        <button type="button" className="btn primary" onClick={() => api.bootDemo().catch((e: Error) => onError(e.message))}>Boot demo mesh</button>
        <button type="button" className="btn destructive" disabled={!liveNodes && !liveLh} onClick={stopAll}>Stop all…</button>
      </header>

      {mode === "gcs" ? (
        <GcsView state={state} activeThreat={activeThreat} onError={onError} />
      ) : mode === "lighthouse" ? (
        <LighthouseModeView state={state} events={events} />
      ) : (
        <>
          <StatusStrip state={state} />
          <div className="situation">
            <SituationPanel state={state} activeThreat={activeThreat} onError={onError} />
            <TimelinePanel state={state} />
          </div>
          <div className="act">
            <ProcPanel state={state} onError={onError} confirm={confirm} />
            <ThreatPanel state={state} activeThreat={activeThreat} onError={onError} />
            <SignalsPanel state={state} onError={onError} />
          </div>
          <Disclosure id="matrix" title="Convergence matrix" summary={observers ? `${observers} observer${observers === 1 ? "" : "s"} · ${subjects} subject${subjects === 1 ? "" : "s"} · who believes what` : "no observers yet"}>
            <ConvergenceMatrix state={state} />
          </Disclosure>
          <div className="two">
            <Disclosure id="resolve" title="Resolve a service" summary="Consul-style lookup through any node">
              <ResolvePanel state={state} />
            </Disclosure>
            <Disclosure id="log" title="Live log" summary={`${events.length} line${events.length === 1 ? "" : "s"} · ${state.procs.filter((p) => p.running).length} processes`}>
              <EventLog events={events} />
            </Disclosure>
          </div>
        </>
      )}
      <ConfirmSheet req={confirmReq} onClose={closeConfirm} />
    </div>
  );
}
