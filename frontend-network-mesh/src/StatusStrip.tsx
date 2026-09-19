import type { MeshState } from "./types";
import { groupRemotes } from "./remotes";
import { isLiveTrack } from "./Engagement";
import { fmtTime } from "./ui";

/** Four figures an operator reads in one glance, each with a semantic stripe. */
export function StatusStrip({ state }: { state: MeshState }) {
  const nodes = state.procs.filter((p) => p.kind === "node");
  const nodesUp = nodes.filter((p) => p.running).length;
  const lhs = state.procs.filter((p) => p.kind === "lighthouse");
  const lhUp = lhs.filter((p) => p.running).length;
  const devices = groupRemotes(state.remotes);
  const reachable = devices.filter((d) => d.alive > 0).length;
  const live = state.tracks.filter(isLiveTrack).length;
  const neutralised = state.tracks.filter((t) => t.state === "neutralised").length;
  const impacts = state.tracks.filter((t) => t.state === "impact").length;
  const lost = state.tracks.filter((t) => t.state === "lost").length;
  const signals = state.messages.filter((m) => m.kind === "gcs.signal" || m.kind === "track.detected");
  const last = signals.at(-1);

  const nodeStripe = !nodes.length ? "var(--muted)" : nodesUp === nodes.length ? "var(--alive)" : nodesUp === 0 ? "var(--dead)" : "var(--suspect)";
  const remoteStripe = !devices.length ? "var(--muted)" : reachable === devices.length ? "var(--alive)" : reachable === 0 ? "var(--dead)" : "var(--suspect)";
  const targetStripe = live ? "var(--threat)" : "var(--muted)";
  const agreeStripe = !last ? "var(--muted)" : last.consistent ? "var(--accent)" : "var(--dead)";

  return (
    <div className="strip" aria-label="Mesh status">
      <div className="tile" style={{ "--stripe": nodeStripe } as React.CSSProperties}>
        <span className="lbl">Local nodes</span>
        <span className="val">{nodesUp}<small>of {nodes.length} alive</small></span>
        <span className="det">{lhUp} of {lhs.length} lighthouses running{state.device ? ` · ${state.device}` : ""}</span>
      </div>
      <div className="tile" style={{ "--stripe": remoteStripe } as React.CSSProperties}>
        <span className="lbl">Remote devices</span>
        <span className="val">{reachable}<small>of {devices.length} reachable</small></span>
        <span className="det">
          {devices.length
            ? devices.map((d) => `${d.device} ${d.alive}/${d.members.length}`).join(" · ")
            : state.extraLighthouses.length ? `none yet via ${state.extraLighthouses.join(", ")}` : "no external lighthouse configured"}
        </span>
      </div>
      <div className="tile" style={{ "--stripe": targetStripe } as React.CSSProperties}>
        <span className="lbl">Live targets</span>
        <span className="val">{live}<small>{state.tracks.length} total</small></span>
        <span className="det">{state.tracks.length ? `${neutralised} neutralised · ${impacts} impact${impacts === 1 ? "" : "s"}${lost ? ` · ${lost} lost` : ""}` : "no targets yet"}</span>
      </div>
      <div className="tile" style={{ "--stripe": agreeStripe } as React.CSSProperties}>
        <span className="lbl">Agreement</span>
        {last
          ? <span className="val">{last.agree}<small>of {last.seenBy.length} nodes</small></span>
          : <span className="val">—</span>}
        <span className="det">{last ? `last signal ${fmtTime(last.at)} · ${last.consistent ? "identical chain everywhere" : "views had not converged"}` : "no signals yet"}</span>
      </div>
    </div>
  );
}
