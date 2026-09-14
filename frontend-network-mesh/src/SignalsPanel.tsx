import type { InboxMessage, MeshState } from "./types";
import { systemLabel } from "./defense";
import { hostOfNode } from "./remotes";
import { TrackBadge, TrackControls, trackFor } from "./Engagement";

const sysName = systemLabel;
const MAX_ROWS = 8;

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

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
    <div className={`signal-row${mine ? " mine" : ""}`}>
      <div className="signal-head">
        <span className="signal-time">{fmtTime(m.at)}</span>
        <span className="threat-tag">{String(m.body.threat)}</span>
        <span className="signal-from">
          {m.from.station ?? m.from.node}
          {m.from.device && <span className="signal-device"> @ {m.from.device}{host ? ` (${host})` : ""}</span>}
          {remote && <span className="remote-tag" style={{ marginLeft: 6 }}>remote</span>}
          {mine && <span className="mine-tag">you</span>}
        </span>
        <span className="spacer" />
        <span className={`agree-tag${m.consistent ? "" : " bad"}`}
          title={m.consistent
            ? `local nodes that received this signal, all computing the same actions: ${m.seenBy.join(", ")}`
            : `${m.agree} of ${m.seenBy.length} local nodes computed the same actions — the others' views had not converged at that instant`}>
          {m.agree}/{observers || m.seenBy.length} agree
        </span>
      </div>
      <div className="signal-actions">
        {a ? (
          a.primary ? (
            <>
              <span className="muted">engage →</span>
              <b className="threat-primary">{sysName(a.primary)}</b>
              {a.fallbacks.map((f) => (
                <span key={f} className="threat-fallback"> → {sysName(f)}</span>
              ))}
            </>
          ) : (
            <b className="threat-leaked">NO COVERAGE — THREAT LEAKED</b>
          )
        ) : (
          <span className="muted">no assignment</span>
        )}
        {typeof m.body.note === "string" && m.body.note && (
          <span className="signal-note">“{m.body.note}”</span>
        )}
      </div>
      {track && (
        <div className="signal-lifecycle">
          <TrackBadge t={track} state={state} />
          {onError && <TrackControls t={track} state={state} station={station} command={command} onError={onError} />}
        </div>
      )}
    </div>
  );
}

/** Command-mode feed: every GCS signal on the mesh, from any device, newest first. */
export function SignalsPanel({ state, onError }: { state: MeshState; onError?: (m: string) => void }) {
  const signals = state.messages.filter((m) => m.kind === "gcs.signal").slice(-MAX_ROWS).reverse();
  return (
    <div className="panel">
      <h2>GCS signals — actions taken <span className="remote-tag">live</span></h2>
      {signals.length ? (
        <div className="signal-list">
          {signals.map((m) => <SignalRow key={m.id} m={m} state={state} command onError={onError} />)}
        </div>
      ) : (
        <div style={{ color: "var(--muted)", fontSize: 12, padding: "4px 2px" }}>
          No signals yet. Switch to <b>GCS</b> mode (here or on another device) and send one —
          every node on every device matchmakes it and the actions appear here automatically.
        </div>
      )}
    </div>
  );
}
