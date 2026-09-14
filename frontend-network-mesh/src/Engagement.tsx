import { useState } from "react";
import { api } from "./api";
import type { MeshState, TrackView } from "./types";
import { systemLabel } from "./defense";
import { fmtTime } from "./SignalsPanel";

export const trackFor = (state: MeshState, id: string): TrackView | undefined => state.tracks.find((t) => t.trackId === id);
export const isLiveTrack = (t: TrackView) => t.state === "detected" || t.state === "engaging";

/** One-word state with colour, plus who is responsible now. */
export function TrackBadge({ t, state }: { t: TrackView; state: MeshState }) {
  const cls = t.state === "neutralised" ? "tb-done" : t.state === "lost" ? "tb-lost" : t.state === "engaging" ? "tb-engaging" : "tb-detected";
  const mine = !!t.responsibleDevice && t.responsibleDevice === state.device;
  return (
    <span className="track-badge-row">
      <span className={`track-badge ${cls}`}>
        {t.state === "neutralised" ? "✔ neutralised" : t.state === "lost" ? "lost" : t.state === "engaging" ? "engaging" : "awaiting engagement"}
      </span>
      {isLiveTrack(t) && (
        t.responsibleNode
          ? <span className="muted">responsible: <b style={{ color: mine ? "var(--accent)" : "var(--text)" }}>{t.responsibleDevice ?? "?"}</b> ({systemLabel(t.responsibleNode)}){mine && <span className="mine-tag">you</span>}</span>
          : <span className="threat-leaked">nobody left in the chain — LEAKED</span>
      )}
      {t.state === "neutralised" && t.neutralised && (
        <span className="muted">by <b style={{ color: "var(--text)" }}>{t.neutralised.station ?? t.neutralised.device ?? t.neutralised.node}</b> at {fmtTime(t.neutralised.at)}{t.neutralised.override && <span className="agree-tag bad" style={{ marginLeft: 6 }}>Command override</span>}</span>
      )}
      {t.escalations.length > 0 && (
        <span className="muted" title={t.escalations.map((e) => `${fmtTime(e.at)} ${e.reason}: ${e.from ?? "nobody"} → ${e.to ?? "NOBODY"}${e.note ? ` (${e.note})` : ""}`).join("\n")}>
          · escalated ×{t.escalations.length} ({t.escalations.at(-1)!.reason})
        </span>
      )}
      {t.rejected.length > 0 && (
        <span className="lh-bad" title={t.rejected.map((r) => `${fmtTime(r.at)} ${r.action} by ${r.device ?? r.node}: ${r.reason}`).join("\n")}>
          · {t.rejected.length} rejected attempt{t.rejected.length === 1 ? "" : "s"}
        </span>
      )}
      <span className={`agree-tag${t.consistent ? "" : " bad"}`} title={`local nodes agreeing on state + responsible: ${t.seenBy.join(", ")}`}>{t.agree}/{t.seenBy.length}</span>
    </span>
  );
}

/** NEUTRALISED / hand over controls — enabled only while this device is responsible
 *  (the mesh would reject anything else; Command may override). */
export function TrackControls({ t, state, station, command, onError }: {
  t: TrackView; state: MeshState; station?: string; command?: boolean; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const mine = !!t.responsibleDevice && t.responsibleDevice === state.device;
  if (!isLiveTrack(t)) return null;
  const run = async (action: "neutralise" | "handover" | "engaging", opts: { override?: boolean; note?: string } = {}) => {
    setBusy(action);
    try { await api.trackAction(t.trackId, action, { station, ...opts }); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <span className="track-controls">
      {mine && t.state === "detected" && (
        <button className="primary" disabled={!!busy} onClick={() => run("engaging")}>ENGAGE</button>
      )}
      {mine && (
        <button className="neutralise" disabled={!!busy} onClick={() => run("neutralise")}>✔ NEUTRALISED</button>
      )}
      {mine && (
        <button disabled={!!busy} title="pass responsibility to the next fallback" onClick={() => run("handover", { note: "handed over by operator" })}>hand over</button>
      )}
      {!mine && command && (
        <button className="danger" disabled={!!busy} title="Command override: neutralise although this device is not responsible (logged)"
          onClick={() => run("neutralise", { override: true })}>override: neutralised</button>
      )}
      {!mine && !command && <span className="muted" style={{ fontSize: 12 }}>waiting on {t.responsibleDevice ?? "?"}</span>}
    </span>
  );
}

/** Command-mode timeline: every lifecycle event across all tracks, newest first. */
export function TimelinePanel({ state }: { state: MeshState }) {
  const events: { at: number; text: string; cls?: string }[] = [];
  for (const t of state.tracks) {
    const who = t.origin.station ?? t.origin.node;
    events.push({ at: t.detectedAt, text: `${t.threat.toUpperCase()} detected by ${who}@${t.origin.device ?? "?"} → ${t.chain[0] ? systemLabel(t.chain[0]) : "no coverage"}`, cls: "log-good" });
    for (const e of t.escalations) events.push({ at: e.at, text: `${t.threat.toUpperCase()} escalated (${e.reason}${e.note ? `: ${e.note}` : ""}): ${e.from ? systemLabel(e.from) : "nobody"} → ${e.to ? systemLabel(e.to) : "NOBODY LEFT"}`, cls: "log-warn" });
    for (const r of t.rejected) events.push({ at: r.at, text: `${t.threat.toUpperCase()} ${r.action} by ${r.device ?? r.node} REJECTED — ${r.reason}`, cls: "log-bad" });
    if (t.engagingAt) events.push({ at: t.engagingAt, text: `${t.threat.toUpperCase()} engaging — ${t.responsibleDevice ?? t.responsibleNode ?? "?"} acknowledged` });
    if (t.neutralised) events.push({ at: t.neutralised.at, text: `${t.threat.toUpperCase()} NEUTRALISED by ${t.neutralised.station ?? t.neutralised.device ?? t.neutralised.node}${t.neutralised.override ? " (Command override)" : ""}`, cls: "log-good" });
    if (t.lostAt) events.push({ at: t.lostAt, text: `${t.threat.toUpperCase()} lost — updates stopped`, cls: "log-warn" });
  }
  events.sort((a, b) => b.at - a.at);
  const live = state.tracks.filter(isLiveTrack).length;
  return (
    <div className="panel">
      <h2>Engagement timeline <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· {live} live, {state.tracks.length} total</span></h2>
      {events.length ? (
        <div className="log" style={{ height: 200 }}>
          {events.slice(0, 60).map((e, i) => (
            <div key={i} className={e.cls}><span className="src" style={{ color: "var(--muted)" }}>{fmtTime(e.at)}</span><span>{e.text}</span></div>
          ))}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>No targets yet. A GCS signal creates a track; its responsible GCS engages and neutralises it, or the mesh escalates down the fallback chain.</div>
      )}
    </div>
  );
}
