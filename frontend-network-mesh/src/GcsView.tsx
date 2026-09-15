import { useEffect, useState } from "react";
import { api } from "./api";
import type { InboxMessage, MeshState, ScenarioInfo, ThreatAssignmentEvent, ThreatType } from "./types";
import { deviceOf, systemLabel, systemName, systemOf } from "./defense";
import { SignalRow, fmtTime } from "./SignalsPanel";
import { groupRemotes } from "./remotes";
import { MapPanel } from "./MapPanel";
import { TrackBadge, TrackControls, isLiveTrack, trackFor } from "./Engagement";

const SIM_THREATS: { type: ThreatType; label: string; eta: number }[] = [
  { type: "missile", label: "🚀 missile", eta: 45_000 },
  { type: "swarm", label: "🐝 swarm", eta: 120_000 },
  { type: "aircraft", label: "✈️ aircraft", eta: 90_000 },
];

const STATION_KEY = "mesh-gcs-station";
const THREATS: { type: ThreatType; icon: string; hint: string }[] = [
  { type: "missile", icon: "🚀", hint: "ballistic / cruise" },
  { type: "swarm", icon: "🐝", hint: "drone swarm" },
  { type: "aircraft", icon: "✈️", hint: "manned / large UAV" },
  { type: "emp", icon: "⚡", hint: "electronic attack" },
];
const sysName = systemLabel;

/**
 * Ground Control Station mode. An operator names their station, reports a
 * threat, and watches the mesh decide. The feed shows every station's signals
 * — this device's and the ones arriving from other devices over the internet —
 * with the actions taken, updating live without any coordination between
 * stations: each node ran the same deterministic matchmaking.
 */
export function GcsView({
  state,
  activeThreat,
  onError,
}: {
  state: MeshState;
  activeThreat: ThreatAssignmentEvent | null;
  onError: (m: string) => void;
}) {
  const [station, setStation] = useState(() => {
    try { return localStorage.getItem(STATION_KEY) ?? ""; } catch { return ""; }
  });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<ThreatType | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null); // message id
  // Scenario launcher (simulated incoming target): pick threat, target and ETA, then click the map for the origin.
  const [simThreat, setSimThreat] = useState<ThreatType>("missile");
  const [simTarget, setSimTarget] = useState("");
  const [simEta, setSimEta] = useState(45_000);
  const [picking, setPicking] = useState(false);
  const targets = Object.entries(state.geo.entries).filter(([id]) => id !== state.device);
  const launch = async (origin: { lat: number; lng: number }) => {
    setPicking(false);
    try {
      await api.startSim({ threat: simThreat, origin, target: simTarget, etaMs: simEta, station: stationName });
    } catch (e) { onError((e as Error).message); }
  };
  // Scripted scenarios (several launches against one target), listed by the control plane.
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [scenarioMsg, setScenarioMsg] = useState<string | null>(null);
  useEffect(() => {
    api.listScenarios().then((s) => { setScenarios(s); setScenarioId((id) => id || s[0]?.id || ""); }).catch(() => { /* older control plane */ });
  }, []);
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const runScenario = async () => {
    setScenarioMsg(null);
    try {
      const r = await api.runScenario(scenarioId, { target: simTarget || undefined, station: stationName });
      setScenarioMsg(`${scenario?.name ?? r.scenario} → ${state.geo.entries[r.target]?.label ?? r.target}: ${r.launches} launch${r.launches === 1 ? "" : "es"} scheduled`);
    } catch (e) { onError((e as Error).message); }
  };
  const [myIds, setMyIds] = useState<Set<string>>(() => new Set());

  const defaultStation = state.device ? `GCS-${state.device}` : "GCS";
  const stationName = station.trim() || defaultStation;
  useEffect(() => {
    try { localStorage.setItem(STATION_KEY, station); } catch { /* ignore */ }
  }, [station]);

  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running);
  const aliveRemotes = state.remotes.filter((r) => r.status === "alive");
  const remoteDevices = groupRemotes(state.remotes);
  const signals = state.messages.filter((m) => m.kind === "gcs.signal" || m.kind === "track.detected");
  const myLive = state.tracks.filter((t) => isLiveTrack(t) && t.responsibleDevice === state.device);
  const latest: InboxMessage | undefined = signals.at(-1);
  const highlighted = activeThreat && latest && activeThreat.threatId === latest.id ? latest : latest;

  const send = async (t: ThreatType) => {
    setBusy(t);
    try {
      const m = await api.sendSignal(t, stationName, note.trim() || undefined);
      setLastSent(m.id);
      setMyIds((prev) => new Set(prev).add(m.id));
      setNote("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gcs">
      <div className="gcs-col">
        <div className="panel gcs-station">
          <h2>Ground control station</h2>
          <div className="row" style={{ gap: 10 }}>
            <label className="gcs-label">station</label>
            <input size={16} value={station} placeholder={defaultStation}
              onChange={(e) => setStation(e.target.value)} />
            <span className="muted">on device <b style={{ color: "var(--text)" }}>{state.device || "…"}</b></span>
          </div>
          <div className="gcs-status">
            <span><b>{liveNodes.length}</b> local nodes</span>
            <span><b>{remoteDevices.length}</b> remote device{remoteDevices.length === 1 ? "" : "s"}
              {remoteDevices.length > 0 && (
                <span className="muted"> — {remoteDevices.map((d) => `${d.device} (${d.host}, ${d.alive}/${d.members.length} alive)`).join(" · ")}</span>
              )}
            </span>
            <span><b>{signals.length}</b> signals on the mesh</span>
            <span style={myLive.length ? { color: "var(--suspect)", fontWeight: 700 } : undefined}><b>{myLive.length}</b> target{myLive.length === 1 ? "" : "s"} waiting on this station</span>
          </div>
        </div>

        <div className="panel">
          <h2>Report a threat</h2>
          <div className="gcs-threats">
            {THREATS.map(({ type, icon, hint }) => (
              <button key={type} className="gcs-threat" disabled={!!busy || !liveNodes.length}
                onClick={() => send(type)} title={hint}>
                <span className="gcs-threat-icon">{icon}</span>
                <span className="gcs-threat-name">{type}</span>
                <span className="gcs-threat-hint">{hint}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input style={{ flex: 1 }} placeholder="optional note, e.g. bearing 045 · 12 km · 3 contacts"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {!liveNodes.length && (
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              No local node is running — press <b>Boot demo mesh</b> first (a station sends through a local node).
            </div>
          )}
          {lastSent && (
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              last signal <code>{lastSent}</code> sent as <b>{stationName}</b>
              {(() => {
                const m = state.messages.find((x) => x.id === lastSent);
                return m ? ` · received by ${m.seenBy.length} local node${m.seenBy.length === 1 ? "" : "s"}` : " · propagating…";
              })()}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Launch a simulated incoming target <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· streams its trajectory to every device at 1 Hz</span></h2>
          <div className="row" style={{ gap: 8 }}>
            <select value={simThreat} onChange={(e) => { const t = e.target.value as ThreatType; setSimThreat(t); setSimEta(SIM_THREATS.find((x) => x.type === t)?.eta ?? 90_000); }}>
              {SIM_THREATS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
            </select>
            <span className="muted">→</span>
            <select value={simTarget} onChange={(e) => setSimTarget(e.target.value)}>
              <option value="">target…</option>
              {targets.map(([id, e]) => <option key={id} value={id}>{e.kind === "asset" ? "◆ " : "● "}{e.label ?? id}</option>)}
            </select>
            <span className="muted">impact in</span>
            <select value={simEta} onChange={(e) => setSimEta(Number(e.target.value))}>
              {[30_000, 45_000, 90_000, 180_000, 300_000].map((ms) => <option key={ms} value={ms}>{ms / 1000}s</option>)}
            </select>
            <button className={picking ? "primary" : undefined} disabled={!simTarget || state.sims.length >= 3 || !liveNodes.length}
              onClick={() => setPicking((p) => !p)}>
              {picking ? "click the map for the origin… (cancel)" : "▶ pick origin on map"}
            </button>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <span className="muted">or a scripted scenario:</span>
            <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} disabled={!scenarios.length}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.steps.length} launch{s.steps.length === 1 ? "" : "es"}</option>)}
            </select>
            <button disabled={!scenarioId || !targets.length || !liveNodes.length} onClick={runScenario}
              title={simTarget ? `runs against ${state.geo.entries[simTarget]?.label ?? simTarget}` : "runs against the first defended asset on the map (pick a target above to choose)"}>
              ▶ run scenario
            </button>
          </div>
          {scenario && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{scenario.description}</div>}
          {scenarioMsg && <div style={{ fontSize: 12, marginTop: 4, color: "var(--suspect)" }}>{scenarioMsg}</div>}
          {!targets.length && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No targets on the map yet — in Command mode place devices or defended assets, or press <b>seed Singapore demo layout</b>.</div>}
          {state.sims.length > 0 && (
            <div className="proc-list" style={{ marginTop: 8 }}>
              {state.sims.map((s) => {
                const t = trackFor(state, s.trackId);
                return (
                  <div className="proc" key={s.trackId}>
                    <span className="dot" style={{ background: "var(--suspect)" }} />
                    <span className="name">{s.threat}</span>
                    <span className="meta">→ {state.geo.entries[s.target]?.label ?? s.target} · seq {s.seq} · {t ? `${t.state}, responsible ${t.responsibleDevice ?? "nobody"}` : "launching…"}</span>
                    <button className="danger" onClick={() => api.cancelSim(s.trackId).catch((e: Error) => onError(e.message))}>cancel</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {highlighted && highlighted.assignment && (
          <div className="panel gcs-engage">
            <h2>Latest engagement</h2>
            <div className="gcs-engage-head">
              <span className="threat-tag" style={{ fontSize: 14, padding: "4px 10px" }}>
                {String(highlighted.body.threat)}
              </span>
              <span className="muted">
                reported {fmtTime(highlighted.at)} by <b style={{ color: "var(--text)" }}>{highlighted.from.station ?? highlighted.from.node}</b>
                {highlighted.from.device && ` on ${highlighted.from.device}`}
              </span>
            </div>
            {highlighted.assignment.primary ? (
              <div className="gcs-engage-chain">
                <div className="gcs-primary">
                  <div className="gcs-primary-label">engaging</div>
                  <div className="gcs-primary-name">{systemName(highlighted.assignment.primary)}</div>
                  <div className="muted">
                    {systemOf(highlighted.assignment.primary)?.layer ?? ""}
                    {deviceOf(highlighted.assignment.primary) && <span className="gcs-device"> · on {deviceOf(highlighted.assignment.primary)}</span>}
                  </div>
                </div>
                {highlighted.assignment.fallbacks.map((f, i) => (
                  <div className="gcs-fallback" key={f}>
                    <div className="gcs-primary-label">fallback {i + 1}</div>
                    <div className="gcs-fallback-name">{systemName(f)}</div>
                    <div className="muted">
                      {systemOf(f)?.layer ?? ""}
                      {deviceOf(f) && <span className="gcs-device"> · on {deviceOf(f)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <b className="threat-leaked" style={{ fontSize: 16 }}>NO COVERAGE — THREAT LEAKED</b>
            )}
            {trackFor(state, highlighted.id) && (
              <div className="signal-lifecycle" style={{ marginTop: 10 }}>
                <TrackBadge t={trackFor(state, highlighted.id)!} state={state} />
                <TrackControls t={trackFor(state, highlighted.id)!} state={state} station={stationName} onError={onError} />
              </div>
            )}
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {highlighted.consistent
                ? `${highlighted.seenBy.length} local node${highlighted.seenBy.length === 1 ? "" : "s"} computed this identical answer independently`
                : `${highlighted.agree} of ${highlighted.seenBy.length} local nodes computed this answer — the rest had a different view at that instant`}
            </div>
          </div>
        )}
      </div>

      <div className="gcs-col">
        <MapPanel state={state} editable={false} height={340} pickOrigin={picking} onPickOrigin={launch} />
        <div className="panel gcs-feed">
          <h2>Signals on the mesh — all stations, all devices <span className="remote-tag">live</span></h2>
          {signals.length ? (
            <div className="signal-list">
              {[...signals].reverse().map((m) => (
                <SignalRow key={m.id} m={m} state={state} mine={myIds.has(m.id)} station={stationName} onError={onError} />
              ))}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              Waiting for signals. Report a threat here, or from a GCS on any other device joined to the same
              lighthouse — it will appear here with the actions taken.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
