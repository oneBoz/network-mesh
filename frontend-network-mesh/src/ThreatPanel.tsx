import { useState } from "react";
import { api } from "./api";
import type { MeshState, ThreatAssignmentEvent, ThreatType } from "./types";
import { DEFENSE_SYSTEMS } from "./defense";

const THREATS: { type: ThreatType; icon: string }[] = [
  { type: "missile", icon: "🚀" },
  { type: "swarm", icon: "🐝" },
  { type: "aircraft", icon: "✈️" },
  { type: "emp", icon: "⚡" },
];

const sysName = (id: string) => DEFENSE_SYSTEMS[id]?.name ?? id;

/**
 * Threat injection: hit any node's /threat endpoint via the control plane and
 * show the mesh's ranked answer. Whichever node ingests it computes the same
 * assignment (deterministic matchmaking over the shared view) — try different
 * "via" nodes to prove it.
 */
export function ThreatPanel({
  state,
  activeThreat,
  onError,
}: {
  state: MeshState;
  activeThreat: ThreatAssignmentEvent | null;
  onError: (m: string) => void;
}) {
  const [via, setVia] = useState("");
  const [busy, setBusy] = useState(false);

  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running);
  const latest = activeThreat ?? state.threats.at(-1) ?? null;

  const inject = async (t: ThreatType) => {
    setBusy(true);
    try {
      await api.injectThreat(t, via || undefined);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Inject a threat</h2>
      <div className="row">
        {THREATS.map(({ type, icon }) => (
          <button key={type} className="threat-btn" disabled={busy || !liveNodes.length}
            onClick={() => inject(type)}>
            {icon} {type}
          </button>
        ))}
        <span style={{ color: "var(--muted)" }}>via</span>
        <select value={via} onChange={(e) => setVia(e.target.value)}>
          <option value="">any node</option>
          {liveNodes.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      </div>

      {latest && (
        <div className="threat-result">
          <div className="threat-line">
            <span className="threat-tag">{latest.threat}</span>
            <span style={{ color: "var(--muted)" }}>detected by {latest.via} →</span>
            {latest.primary ? (
              <span className="threat-chain">
                <b className="threat-primary">{sysName(latest.primary)}</b>
                {latest.fallbacks.map((f) => (
                  <span key={f} className="threat-fallback"> → {sysName(f)}</span>
                ))}
              </span>
            ) : (
              <b className="threat-leaked">NO COVERAGE — THREAT LEAKED</b>
            )}
          </div>
          {state.threats.length > 1 && (
            <div className="threat-history">
              {state.threats.slice(0, -1).slice(-4).reverse().map((t) => (
                <div key={t.threatId} className="threat-history-row">
                  <span className="threat-tag">{t.threat}</span>
                  <span>via {t.via} → {t.primary ?? "LEAKED"}
                    {t.fallbacks.length ? ` (${t.fallbacks.join(", ")})` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
