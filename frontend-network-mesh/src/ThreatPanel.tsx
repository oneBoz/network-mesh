import { useState } from "react";
import { api } from "./api";
import type { MeshState, ThreatAssignmentEvent, ThreatType } from "./types";
import { systemLabel } from "./defense";
import { Field, PanelHead, Pill, THREAT_HINT, THREAT_LABEL, ThreatIcon } from "./ui";

const THREATS: ThreatType[] = ["missile", "swarm", "aircraft", "emp"];

/**
 * Threat injection: hit any node's /threat endpoint via the control plane and
 * show the mesh's ranked answer. Whichever node ingests it computes the same
 * assignment (deterministic matchmaking over the shared view) — try different
 * "via" nodes to prove it.
 */
export function ThreatPanel({ state, activeThreat, onError }: { state: MeshState; activeThreat: ThreatAssignmentEvent | null; onError: (m: string) => void }) {
  const [via, setVia] = useState("");
  const [busy, setBusy] = useState(false);
  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running);
  const latest = activeThreat ?? state.threats.at(-1) ?? null;

  const inject = async (t: ThreatType) => {
    setBusy(true);
    try { await api.injectThreat(t, via || undefined); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <PanelHead title="Inject a threat" sub="any node matchmakes it" />
      <div className="threats two-up">
        {THREATS.map((t) => (
          <button key={t} type="button" className="threat-btn" disabled={busy || !liveNodes.length} onClick={() => inject(t)}>
            <ThreatIcon type={t} /><span className="n">{THREAT_LABEL[t]}</span><span className="h">{THREAT_HINT[t]}</span>
          </button>
        ))}
      </div>
      <div className="row end" style={{ marginTop: 10 }}>
        <Field label="Ingest via">
          <select id="threat-via" value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">Any node</option>
            {liveNodes.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </Field>
        {!liveNodes.length && <span className="muted small">No local node is running — boot the demo first.</span>}
      </div>
      {latest && (
        <div className="well" style={{ marginTop: 10 }}>
          <div className="row"><Pill tone="threat">{latest.threat}</Pill><span className="muted">via {latest.via} →</span></div>
          <div className="chain" style={{ marginTop: 4 }}>
            {latest.primary ? (
              <><span className="p">{systemLabel(latest.primary)}</span>{latest.fallbacks.length > 0 && <span className="f">→ {latest.fallbacks.map((f) => systemLabel(f)).join(" → ")}</span>}</>
            ) : (
              <span className="threat-leaked">No coverage — threat leaked</span>
            )}
          </div>
          {state.threats.length > 1 && (
            <div className="threat-history">
              {state.threats.slice(0, -1).slice(-4).reverse().map((t) => (
                <div key={t.threatId}><span className="mono">{t.threat}</span> via {t.via} → {t.primary ? systemLabel(t.primary) : "leaked"}{t.fallbacks.length ? ` (${t.fallbacks.map((f) => systemLabel(f)).join(", ")})` : ""}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
