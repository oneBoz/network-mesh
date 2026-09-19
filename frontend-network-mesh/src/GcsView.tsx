import { useEffect, useState } from "react";
import { api } from "./api";
import type { InboxMessage, MeshState, ScenarioInfo, ThreatAssignmentEvent, ThreatType } from "./types";
import { deviceOf, systemName, systemOf } from "./defense";
import { SignalRow } from "./SignalsPanel";
import { groupRemotes } from "./remotes";
import { MapPanel } from "./MapPanel";
import { TrackBadge, TrackControls, isLiveTrack, trackFor } from "./Engagement";
import { Field, PanelHead, Pill, THREAT_HINT, THREAT_LABEL, ThreatIcon, fmtTime } from "./ui";

const SIM_THREATS: { type: ThreatType; label: string; eta: number }[] = [
  { type: "missile", label: "Missile", eta: 45_000 },
  { type: "swarm", label: "Swarm", eta: 120_000 },
  { type: "aircraft", label: "Aircraft", eta: 90_000 },
];
const STATION_KEY = "mesh-gcs-station";
const THREATS: ThreatType[] = ["missile", "swarm", "aircraft", "emp"];

/**
 * Ground Control Station mode. An operator names their station, reports a
 * threat, and watches the mesh decide. The feed shows every station's signals
 * — this device's and the ones arriving from other devices over the internet —
 * with the actions taken, updating live without any coordination between
 * stations: each node ran the same deterministic matchmaking.
 */
export function GcsView({ state, activeThreat, onError }: { state: MeshState; activeThreat: ThreatAssignmentEvent | null; onError: (m: string) => void }) {
  const [station, setStation] = useState(() => { try { return localStorage.getItem(STATION_KEY) ?? ""; } catch { return ""; } });
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
    try { await api.startSim({ threat: simThreat, origin, target: simTarget, etaMs: simEta, station: stationName }); }
    catch (e) { onError((e as Error).message); }
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
  useEffect(() => { try { localStorage.setItem(STATION_KEY, station); } catch { /* ignore */ } }, [station]);

  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running);
  const remoteDevices = groupRemotes(state.remotes);
  const reachableDevices = remoteDevices.filter((d) => d.alive > 0).length;
  const signals = state.messages.filter((m) => m.kind === "gcs.signal" || m.kind === "track.detected");
  const myLive = state.tracks.filter((t) => isLiveTrack(t) && t.responsibleDevice === state.device);
  const latest: InboxMessage | undefined = signals.at(-1);
  const highlighted = activeThreat && latest && activeThreat.threatId === latest.id ? latest : latest;
  const highlightedTrack = highlighted ? trackFor(state, highlighted.id) : undefined;

  const send = async (t: ThreatType) => {
    setBusy(t);
    try {
      const m = await api.sendSignal(t, stationName, note.trim() || undefined);
      setLastSent(m.id);
      setMyIds((prev) => new Set(prev).add(m.id));
      setNote("");
    } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  const lastSentMsg = lastSent ? state.messages.find((x) => x.id === lastSent) : undefined;

  return (
    <div className="stack">
      <div className="strip" aria-label="Station status">
        <div className="tile" style={{ "--stripe": "var(--accent)" } as React.CSSProperties}>
          <span className="lbl">Station</span>
          <Field label="Station name"><input id="gcs-station" value={station} placeholder={defaultStation} onChange={(e) => setStation(e.target.value)} /></Field>
          <span className="det">on device {state.device || "…"}</span>
        </div>
        <div className="tile" style={{ "--stripe": liveNodes.length ? "var(--alive)" : "var(--dead)" } as React.CSSProperties}>
          <span className="lbl">Reachable</span>
          <span className="val">{liveNodes.length}<small>local · {reachableDevices} remote device{reachableDevices === 1 ? "" : "s"}</small></span>
          <span className="det">{remoteDevices.length ? remoteDevices.map((d) => `${d.device} ${d.alive}/${d.members.length}`).join(" · ") : "no remote devices yet"}</span>
        </div>
        <div className="tile" style={{ "--stripe": myLive.length ? "var(--threat)" : "var(--muted)" } as React.CSSProperties}>
          <span className="lbl">Waiting on this station</span>
          <span className="val" style={myLive.length ? { color: "var(--threat)" } : undefined}>{myLive.length}<small>target{myLive.length === 1 ? "" : "s"}</small></span>
          <span className="det">{myLive.length ? myLive.map((t) => `${t.threat}${t.positions.at(-1)?.eta !== undefined ? ` · ${Math.max(0, Math.round((t.positions.at(-1)!.eta ?? 0) / 1000))} s to impact` : ""}`).join(" · ") : "nothing waiting on you"}</span>
        </div>
        <div className="tile" style={{ "--stripe": "var(--accent)" } as React.CSSProperties}>
          <span className="lbl">Signals on the mesh</span>
          <span className="val">{signals.length}</span>
          <span className="det">{latest ? `last from ${latest.from.station ?? latest.from.node} at ${fmtTime(latest.at)}` : "none yet"}</span>
        </div>
      </div>

      <div className="gcs">
        <div className="stack">
          <div className="panel">
            <PanelHead title="Report a threat" sub="every device matchmakes it independently" />
            <div className="threats">
              {THREATS.map((t) => (
                <button key={t} type="button" className="threat-btn" disabled={!!busy || !liveNodes.length} onClick={() => send(t)}>
                  <ThreatIcon type={t} /><span className="n">{THREAT_LABEL[t]}</span><span className="h">{THREAT_HINT[t]}</span>
                </button>
              ))}
            </div>
            <div className="row end" style={{ marginTop: 10 }}>
              <Field label="Note (optional)" grow><input id="gcs-note" placeholder="e.g. bearing 045 · 12 km · 3 contacts" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
            {!liveNodes.length && <p className="empty">No local node is running — press <b>Boot demo mesh</b> first (a station sends through a local node).</p>}
            {lastSent && (
              <p className="muted small" style={{ marginTop: 8 }}>
                last signal <span className="mono">{lastSent}</span> sent as <b>{stationName}</b>
                {lastSentMsg ? ` · received by ${lastSentMsg.seenBy.length} local node${lastSentMsg.seenBy.length === 1 ? "" : "s"}` : " · propagating…"}
              </p>
            )}
          </div>

          {highlighted && highlighted.assignment && (
            <div className="panel">
              <PanelHead title="Latest engagement"
                sub={`${String(highlighted.body.threat)} · reported ${fmtTime(highlighted.at)} by ${highlighted.from.station ?? highlighted.from.node}${highlighted.from.device ? ` on ${highlighted.from.device}` : ""}`}
                right={<Pill tone={highlighted.consistent ? "ok" : "bad"} title={highlighted.consistent
                  ? `${highlighted.seenBy.length} local nodes computed this identical answer independently`
                  : `${highlighted.agree} of ${highlighted.seenBy.length} local nodes computed this answer — the rest had a different view at that instant`}>
                  {highlighted.agree}/{highlighted.seenBy.length} agree
                </Pill>} />
              {highlighted.assignment.primary ? (
                <div className="engage">
                  <div className="card primary">
                    <span className="lbl">Engaging</span>
                    <span className="big">{systemName(highlighted.assignment.primary)}</span>
                    <span className="sub">{systemOf(highlighted.assignment.primary)?.layer ?? ""}{deviceOf(highlighted.assignment.primary) ? ` · on ${deviceOf(highlighted.assignment.primary)}` : ""}</span>
                  </div>
                  {highlighted.assignment.fallbacks.slice(0, 2).map((f, i) => (
                    <div className="card" key={f}>
                      <span className="lbl">Fallback {i + 1}</span>
                      <span className="mid">{systemName(f)}</span>
                      <span className="sub">{systemOf(f)?.layer ?? ""}{deviceOf(f) ? ` · on ${deviceOf(f)}` : ""}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="threat-leaked" style={{ fontSize: 16 }}>No coverage — threat leaked</p>
              )}
              {highlighted.assignment.fallbacks.length > 2 && (
                <p className="muted small" style={{ marginTop: 6 }}>then {highlighted.assignment.fallbacks.slice(2).map((f) => systemName(f)).join(" → ")}</p>
              )}
              {highlightedTrack && (
                <div className="lifecycle engage-actions">
                  <TrackBadge t={highlightedTrack} state={state} />
                  <TrackControls t={highlightedTrack} state={state} station={stationName} onError={onError} />
                </div>
              )}
            </div>
          )}

          <div className="panel">
            <PanelHead title="Launch a simulated target" sub="streams its trajectory to every device at 1 Hz" />
            <div className="row end">
              <Field label="Threat">
                <select id="sim-threat" value={simThreat} onChange={(e) => { const t = e.target.value as ThreatType; setSimThreat(t); setSimEta(SIM_THREATS.find((x) => x.type === t)?.eta ?? 90_000); }}>
                  {SIM_THREATS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                </select>
              </Field>
              <Field label="Target">
                <select id="sim-target" value={simTarget} onChange={(e) => setSimTarget(e.target.value)}>
                  <option value="">Choose…</option>
                  {targets.map(([id, e]) => <option key={id} value={id}>{e.kind === "asset" ? "◆ " : "● "}{e.label ?? id}</option>)}
                </select>
              </Field>
              <Field label="Time to impact">
                <select id="sim-eta" value={simEta} onChange={(e) => setSimEta(Number(e.target.value))}>
                  {[30_000, 45_000, 90_000, 180_000, 300_000].map((ms) => <option key={ms} value={ms}>{ms / 1000} s</option>)}
                </select>
              </Field>
              <button type="button" className={`btn${picking ? "" : " primary"}`} aria-pressed={picking} disabled={!simTarget || state.sims.length >= 3 || !liveNodes.length}
                onClick={() => setPicking((p) => !p)}>
                {picking ? "Cancel picking" : "Pick origin on map"}
              </button>
            </div>
            <div className="row end" style={{ marginTop: 10 }}>
              <Field label="Or run a scripted scenario" grow>
                <select id="sim-scenario" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} disabled={!scenarios.length}>
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.steps.length} launch{s.steps.length === 1 ? "" : "es"}</option>)}
                </select>
              </Field>
              <button type="button" className="btn" disabled={!scenarioId || !targets.length || !liveNodes.length} onClick={runScenario}
                title={simTarget ? `Runs against ${state.geo.entries[simTarget]?.label ?? simTarget}` : "Runs against the first defended asset on the map (pick a target above to choose)"}>
                Run scenario
              </button>
            </div>
            {scenario && <p className="muted small" style={{ marginTop: 6 }}>{scenario.description}</p>}
            {scenarioMsg && <p className="small" style={{ marginTop: 4, color: "var(--suspect)" }}>{scenarioMsg}</p>}
            {!targets.length && <p className="empty">No targets on the map yet — in Command mode place devices or defended assets, or press <b>Seed Singapore layout</b>.</p>}
            {state.sims.length > 0 && (
              <div className="list" style={{ marginTop: 8 }}>
                {state.sims.map((s) => {
                  const t = trackFor(state, s.trackId);
                  return (
                    <div className="item" key={s.trackId}>
                      <span className="glyph" style={{ color: "var(--threat)" }}><ThreatIcon type={s.threat} /></span>
                      <span className="nm">{THREAT_LABEL[s.threat]} → {state.geo.entries[s.target]?.label ?? s.target}<small>update {s.seq} · {t ? `${t.state}, responsible ${t.responsibleDevice ?? "nobody"}` : "launching…"}</small></span>
                      <span className="acts"><button type="button" className="btn sm destructive" onClick={() => api.cancelSim(s.trackId).catch((e: Error) => onError(e.message))}>Cancel</button></span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <PanelHead title="Map" sub={picking ? "click to set the launch origin" : "Singapore · devices, assets, trajectories"} />
            <MapPanel state={state} editable={false} height={320} pickOrigin={picking} onPickOrigin={launch} />
          </div>
          <div className="panel gcs-feed">
            <PanelHead title="Signals on the mesh" sub="all stations, all devices"><Pill tone="info">live</Pill></PanelHead>
            {signals.length ? (
              <div className="signal-list">
                {[...signals].reverse().map((m) => (
                  <SignalRow key={m.id} m={m} state={state} mine={myIds.has(m.id)} station={stationName} onError={onError} />
                ))}
              </div>
            ) : (
              <p className="empty">Waiting for signals. Report a threat here, or from a GCS on any other device joined to the same lighthouse — it will appear here with the actions taken.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
