import { useState } from "react";
import { api } from "./api";
import type { MeshState, TrackView } from "./types";
import { systemLabel } from "./defense";
import { PanelHead, Pill, cap, fmtTime } from "./ui";
import type { Tone } from "./ui";

export const trackFor = (state: MeshState, id: string): TrackView | undefined => state.tracks.find((t) => t.trackId === id);
export const isLiveTrack = (t: TrackView) => t.state === "detected" || t.state === "engaging";

const STATE_PILL: Record<TrackView["state"], { tone: Tone; label: string }> = {
  detected: { tone: "warn", label: "awaiting engagement" },
  engaging: { tone: "info", label: "engaging" },
  neutralised: { tone: "ok", label: "✔ neutralised" },
  lost: { tone: "neutral", label: "lost" },
  impact: { tone: "bad", label: "✖ impact · leaked" },
};

/** Lifecycle state and who is responsible, as inline items for a `.lifecycle` row. */
export function TrackBadge({ t, state }: { t: TrackView; state: MeshState }) {
  const mine = !!t.responsibleDevice && t.responsibleDevice === state.device;
  const p = STATE_PILL[t.state];
  return (
    <>
      <Pill tone={p.tone}>{p.label}</Pill>
      {isLiveTrack(t) && (
        t.responsibleNode
          ? <span className="reason">responsible <b style={{ color: mine ? "var(--accent)" : "var(--text)" }}>{t.responsibleDevice ?? "?"}</b> ({systemLabel(t.responsibleNode)}){mine && <> <Pill tone="info">you</Pill></>}</span>
          : <span className="threat-leaked">nobody left in the chain — leaked</span>
      )}
      {t.state === "neutralised" && t.neutralised && (
        <span className="reason">by <b style={{ color: "var(--text)" }}>{t.neutralised.station ?? t.neutralised.device ?? t.neutralised.node}</b> at {fmtTime(t.neutralised.at)}{t.neutralised.override && <> <Pill tone="bad">Command override</Pill></>}</span>
      )}
      {t.escalations.length > 0 && (
        <span className="reason" title={t.escalations.map((e) => `${fmtTime(e.at)} ${e.reason}: ${e.from ?? "nobody"} → ${e.to ?? "NOBODY"}${e.note ? ` (${e.note})` : ""}`).join("\n")}>
          escalated ×{t.escalations.length} ({t.escalations.at(-1)!.reason})
        </span>
      )}
      {t.rejected.length > 0 && (
        <span className="reason" style={{ color: "var(--dead)" }} title={t.rejected.map((r) => `${fmtTime(r.at)} ${r.action} by ${r.device ?? r.node}: ${r.reason}`).join("\n")}>
          {t.rejected.length} rejected attempt{t.rejected.length === 1 ? "" : "s"}
        </span>
      )}
      <Pill tone={t.consistent ? "ok" : "bad"} title={`local nodes agreeing on state + responsible: ${t.seenBy.join(", ")}`}>{t.agree}/{t.seenBy.length} agree</Pill>
    </>
  );
}

/** Engage / Neutralised / Hand over — enabled only while this device is responsible
 *  (the mesh would reject anything else; Command may override, which is logged). */
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
    <span className="controls">
      {mine && t.state === "detected" && <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => run("engaging")}>Engage</button>}
      {mine && <button type="button" className="btn sm confirm" disabled={!!busy} onClick={() => run("neutralise")}>Neutralised</button>}
      {mine && <button type="button" className="btn sm quiet" disabled={!!busy} title="pass responsibility to the next fallback" onClick={() => run("handover", { note: "handed over by operator" })}>Hand over</button>}
      {!mine && command && (
        <button type="button" className="btn sm destructive" disabled={!!busy} title="Command override: neutralise although this device is not responsible (logged)"
          onClick={() => run("neutralise", { override: true })}>Override: neutralised</button>
      )}
      {!mine && !command && <span className="reason">waiting on {t.responsibleDevice ?? "?"}</span>}
    </span>
  );
}

const THREAT_WORD = (t: TrackView) => cap(t.threat);

/** Command-mode timeline: every lifecycle event across all tracks, newest first. */
export function TimelinePanel({ state }: { state: MeshState }) {
  const events: { at: number; text: React.ReactNode; tone: Tone }[] = [];
  const assetLabel = (id?: string) => (id ? state.geo.entries[id]?.label ?? id : "target");
  for (const t of state.tracks) {
    const who = t.origin.station ?? t.origin.node;
    const T = THREAT_WORD(t);
    events.push({ at: t.detectedAt, tone: "info", text: <><b>{T}</b> detected by {who}@{t.origin.device ?? "?"} → {t.chain[0] ? systemLabel(t.chain[0]) : "no coverage"}</> });
    for (const e of t.escalations) events.push({ at: e.at, tone: "warn", text: <><b>{T}</b> escalated on {e.reason}{e.note ? ` (${e.note})` : ""} · {e.from ? systemLabel(e.from) : "nobody"} → {e.to ? systemLabel(e.to) : "nobody left"}</> });
    for (const r of t.rejected) events.push({ at: r.at, tone: "bad", text: <><b>{T}</b> {r.action} by {r.device ?? r.node} rejected · {r.reason}</> });
    if (t.engagingAt) events.push({ at: t.engagingAt, tone: "info", text: <><b>{T}</b> engaging · {t.responsibleDevice ?? t.responsibleNode ?? "?"} acknowledged</> });
    if (t.neutralised) events.push({ at: t.neutralised.at, tone: "ok", text: <><b>{T}</b> neutralised by {t.neutralised.station ?? t.neutralised.device ?? t.neutralised.node}{t.neutralised.override ? " (Command override)" : ""}</> });
    if (t.lostAt) events.push({ at: t.lostAt, tone: "neutral", text: <><b>{T}</b> lost · updates stopped</> });
    if (t.impactAt) events.push({ at: t.impactAt, tone: "bad", text: <><b>{T}</b> impact on {assetLabel(t.target)} · the defence leaked</> });
  }
  events.sort((a, b) => b.at - a.at);
  const live = state.tracks.filter(isLiveTrack).length;
  return (
    <div className="panel">
      <PanelHead title="Engagement timeline" sub={`${live} live · ${state.tracks.length} total`} />
      {events.length ? (
        <div className="timeline">
          {events.slice(0, 80).map((e, i) => (
            <div key={i} className="ev"><span className="t">{fmtTime(e.at)}</span><span className={`k ${e.tone}`} aria-hidden="true" /><span className="x">{e.text}</span></div>
          ))}
        </div>
      ) : (
        <p className="empty">No targets yet. A GCS signal creates a track; its responsible GCS engages and neutralises it, or the mesh escalates down the fallback chain.</p>
      )}
    </div>
  );
}
