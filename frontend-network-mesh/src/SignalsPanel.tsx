import type { InboxMessage, MeshState } from "./types";
import { systemLabel } from "./defense";
import { hostOfNode } from "./remotes";
import { TrackBadge, TrackControls, trackFor } from "./Engagement";
import { PanelHead, Pill, fmtTime } from "./ui";

const MAX_ROWS = 8;

/** One GCS signal and what the mesh did with it, shared by both modes. */
export function SignalRow({ m, state, mine, station, command, onError }: {
  m: InboxMessage; state: MeshState; mine?: boolean; station?: string; command?: boolean; onError?: (msg: string) => void;
}) {
  const observers = state.views.filter((v) => v.reachable).length;
  const track = trackFor(state, m.id);
  const remote = !!m.from.device && !!state.device && m.from.device !== state.device;
  const host = remote ? hostOfNode(state, m.from.node) : undefined;
  const a = m.assignment;
  return (
    <div className={`signal${mine ? " mine" : ""}`}>
      <div className="top">
        <span className="mono muted">{fmtTime(m.at)}</span>
        <Pill tone="threat">{String(m.body.threat)}{m.kind === "track.detected" ? " · track" : ""}</Pill>
        <b>{m.from.station ?? m.from.node}</b>
        {m.from.device && <span className="muted">on {m.from.device}{host ? ` (${host})` : ""}</span>}
        {remote && <Pill tone="info">remote</Pill>}
        {mine && <Pill tone="info">you</Pill>}
        <span className="spacer" />
        <Pill tone={m.consistent ? "ok" : "bad"}
          title={m.consistent
            ? `local nodes that received this signal, all computing the same actions: ${m.seenBy.join(", ")}`
            : `${m.agree} of ${m.seenBy.length} local nodes computed the same actions — the others' views had not converged at that instant`}>
          {m.agree}/{observers || m.seenBy.length} agree
        </Pill>
      </div>
      <div className="chain">
        {a ? (
          a.primary ? (
            <>
              <span className="muted">engage →</span>
              <span className="p">{systemLabel(a.primary)}</span>
              {a.fallbacks.length > 0 && <span className="f">→ {a.fallbacks.map((f) => systemLabel(f)).join(" → ")}</span>}
            </>
          ) : (
            <span className="threat-leaked">No coverage — threat leaked</span>
          )
        ) : (
          <span className="muted">no assignment</span>
        )}
        {typeof m.body.note === "string" && m.body.note && <span className="note">“{m.body.note}”</span>}
      </div>
      {track && (
        <div className="lifecycle">
          <TrackBadge t={track} state={state} />
          {onError && <TrackControls t={track} state={state} station={station} command={command} onError={onError} />}
        </div>
      )}
    </div>
  );
}

/** Command-mode feed: every GCS signal on the mesh, from any device, newest first. */
export function SignalsPanel({ state, onError }: { state: MeshState; onError?: (m: string) => void }) {
  const signals = state.messages.filter((m) => m.kind === "gcs.signal" || m.kind === "track.detected").slice(-MAX_ROWS).reverse();
  return (
    <div className="panel">
      <PanelHead title="GCS signals"><Pill tone="info">live</Pill></PanelHead>
      {signals.length ? (
        <div className="signal-list">
          {signals.map((m) => <SignalRow key={m.id} m={m} state={state} command onError={onError} />)}
        </div>
      ) : (
        <p className="empty">No signals yet. Switch to <b>GCS</b> mode (here or on another device) and send one — every node on every device matchmakes it and the actions appear here.</p>
      )}
    </div>
  );
}
