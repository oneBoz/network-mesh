import type { LighthouseView as LhView, LogEvent, MeshState } from "./types";
import { EventLog } from "./EventLog";
import { systemOf } from "./defense";

const ago = (ms: number) => (ms < 1_000 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);
const uptime = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

/**
 * Lighthouse mode: what this device's lighthouses see. A lighthouse is the
 * mesh's front door, so this is where you watch devices arrive (join), keep
 * alive (announce), move (NAT re-map) and get turned away (wrong key).
 * Registries come from each lighthouse's loopback /registry API; the log is
 * the live stdout of the lighthouse processes only.
 */
export function LighthouseModeView({ state, events }: { state: MeshState; events: LogEvent[] }) {
  const lhs = state.lighthouses;
  const running = state.procs.filter((p) => p.kind === "lighthouse" && p.running).length;
  const unique = new Set(lhs.flatMap((l) => l.entries.map((e) => e.id)));
  const devices = new Set(lhs.flatMap((l) => l.entries.map((e) => e.device ?? "?")));
  const rejected = lhs.reduce((n, l) => n + l.rejected, 0);
  const joins = lhs.reduce((n, l) => n + l.joins, 0);
  const signing = lhs.some((l) => l.reachable && l.signing);
  const isLighthouseSource = (e: LogEvent) => e.source.startsWith("lh-") || /lighthouse|REJECTED|id conflict|moved/.test(e.line);

  return (
    <div className="lh-view">
      <div className="panel">
        <h2>This device as a lighthouse</h2>
        {lhs.length ? (
          <div className="lh-summary">
            <span><b>{running}</b>/{lhs.length} lighthouses running</span>
            <span><b>{unique.size}</b> nodes registered on <b>{devices.size}</b> device{devices.size === 1 ? "" : "s"}</span>
            <span><b>{joins}</b> joins since start</span>
            <span className={rejected ? "lh-bad" : undefined}><b>{rejected}</b> packets rejected{rejected ? " — someone without the key is knocking" : ""}</span>
            <span>{signing ? <span className="agree-tag">signing ON — key required to join</span> : <span className="agree-tag bad">UNSIGNED — anyone can join</span>}</span>
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            This device runs no lighthouse. <b>Boot demo mesh</b> starts three, or add one in Command mode with <b>+ Lighthouse</b>.
            Other devices join <i>this</i> device by putting one of its lighthouse addresses in their <code>EXTRA_LIGHTHOUSES</code>.
          </div>
        )}
        {state.extraLighthouses.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            External lighthouses this device joins: {state.extraLighthouses.join(", ")} — their registries live on those machines; open Lighthouse mode there to see them.
          </div>
        )}
      </div>

      <div className="lh-grid">
        {lhs.map((l) => <LighthouseCard key={l.name} lh={l} device={state.device} />)}
      </div>

      <EventLog events={events} title="Lighthouse log — joins, moves, rejections" filter={isLighthouseSource} height={380} />
    </div>
  );
}

function LighthouseCard({ lh, device }: { lh: LhView; device: string }) {
  const byDevice = new Map<string, number>();
  for (const e of lh.entries) byDevice.set(e.device ?? "?", (byDevice.get(e.device ?? "?") ?? 0) + 1);
  return (
    <div className="panel lh-card">
      <div className="lh-card-head">
        <span className="dot" style={{ background: lh.reachable ? "var(--alive)" : "var(--dead)" }} />
        <b style={{ color: "var(--lh)" }}>{lh.name}</b>
        <span className="muted">udp/{lh.port}</span>
        <span className="spacer" />
        {lh.reachable ? (
          <span className="muted">up {uptime(lh.uptimeMs)} · {lh.joins} joins · <span className={lh.rejected ? "lh-bad" : undefined}>{lh.rejected} rejected</span></span>
        ) : (
          <span className="muted">{lh.port ? "not running" : ""}</span>
        )}
      </div>
      {lh.reachable && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: "4px 0 6px" }}>
            {lh.entries.length} registered · {[...byDevice.entries()].map(([d, n]) => `${d}: ${n}`).join(" · ") || "nobody yet"} · entries expire after {Math.round(lh.staleMs / 1000)}s of silence
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="matrix lh-table">
              <thead>
                <tr><th style={{ textAlign: "left" }}>node</th><th style={{ textAlign: "left" }}>device</th><th style={{ textAlign: "left" }}>hands out</th><th>inc</th><th>last seen</th></tr>
              </thead>
              <tbody>
                {lh.entries.map((e) => {
                  const stale = e.ageMs > 60_000;
                  const local = e.device === device;
                  return (
                    <tr key={e.id} style={stale ? { opacity: 0.45 } : undefined} title={`${e.service ?? ""} · observed at ${e.host}:${e.port}${e.advertise ? ` (advertised ${e.advertise})` : ""}`}>
                      <td style={{ textAlign: "left" }}><b>{systemOf(e.id, e.service)?.short ?? e.id}</b> <span className="muted">{e.id}</span></td>
                      <td style={{ textAlign: "left" }}>{e.device ?? "?"}{local && <span className="mine-tag" style={{ marginLeft: 6 }}>here</span>}</td>
                      <td style={{ textAlign: "left", fontFamily: "Consolas, 'Cascadia Mono', monospace", fontSize: 11.5 }}>{e.host}:{e.port}{e.advertise ? " ⟡" : ""}</td>
                      <td>{e.inc}</td>
                      <td className={stale ? "lh-bad" : undefined}>{ago(e.ageMs)}</td>
                    </tr>
                  );
                })}
                {!lh.entries.length && <tr><td colSpan={5} className="muted" style={{ textAlign: "left" }}>no registrations yet</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
