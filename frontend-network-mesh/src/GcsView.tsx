import { useEffect, useState } from "react";
import { api } from "./api";
import type { InboxMessage, MeshState, ThreatAssignmentEvent, ThreatType } from "./types";
import { deviceOf, systemLabel, systemName, systemOf } from "./defense";
import { SignalRow, fmtTime } from "./SignalsPanel";
import { groupRemotes } from "./remotes";
import { MapPanel } from "./MapPanel";
import { TrackBadge, TrackControls, isLiveTrack, trackFor } from "./Engagement";

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
  const [myIds, setMyIds] = useState<Set<string>>(() => new Set());

  const defaultStation = state.device ? `GCS-${state.device}` : "GCS";
  const stationName = station.trim() || defaultStation;
  useEffect(() => {
    try { localStorage.setItem(STATION_KEY, station); } catch { /* ignore */ }
  }, [station]);

  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running);
  const aliveRemotes = state.remotes.filter((r) => r.status === "alive");
  const remoteDevices = groupRemotes(state.remotes);
  const signals = state.messages.filter((m) => m.kind === "gcs.signal");
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
        <MapPanel state={state} editable={false} height={280} />
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
