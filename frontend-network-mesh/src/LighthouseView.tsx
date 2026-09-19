import { useState } from "react";
import type { LighthouseView as LhView, LogEvent, MeshState, RegistryEntry } from "./types";
import { EventLog } from "./EventLog";
import { systemOf } from "./defense";
import { PanelHead, Pill, Segmented, StatusGlyph, ago, uptime, useNow } from "./ui";

// Stable filter functions (EventLog is memoised on them).
const FILTERS: Record<"all" | "rejections" | "moves", (e: LogEvent) => boolean> = {
  all: (e) => e.source.startsWith("lh-") || /lighthouse|REJECTED|id conflict|moved/.test(e.line),
  rejections: (e) => /REJECTED|rejected packet/.test(e.line),
  moves: (e) => /moved|id conflict/.test(e.line),
};

/**
 * Lighthouse mode: what this device's lighthouses see. A lighthouse is the
 * mesh's front door, so this is where you watch devices arrive (join), keep
 * alive (announce), move (NAT re-map) and get turned away (wrong key).
 * Registries come from each lighthouse's loopback /registry API; the log is
 * the live stdout of the lighthouse processes only.
 */
export function LighthouseModeView({ state, events }: { state: MeshState; events: LogEvent[] }) {
  const now = useNow();
  const [view, setView] = useState<"node" | "lighthouse">("node");
  const [logFilter, setLogFilter] = useState<keyof typeof FILTERS>("all");
  const lhs = state.lighthouses;
  const running = state.procs.filter((p) => p.kind === "lighthouse" && p.running).length;
  const reachable = lhs.filter((l) => l.reachable);
  const unique = new Set(reachable.flatMap((l) => l.entries.map((e) => e.id)));
  const devices = new Set(reachable.flatMap((l) => l.entries.map((e) => e.device ?? "?")));
  const rejected = lhs.reduce((n, l) => n + l.rejected, 0);
  const joins = lhs.reduce((n, l) => n + l.joins, 0);
  const signing = reachable.some((l) => l.signing);
  const staleMs = reachable[0]?.staleMs ?? 120_000;

  // By node: one row per registered node, with the lighthouses that hold it.
  const byNode = new Map<string, { e: RegistryEntry; on: Set<string> }>();
  for (const l of reachable) for (const e of l.entries) {
    const cur = byNode.get(e.id);
    if (!cur) byNode.set(e.id, { e, on: new Set([l.name]) });
    else { cur.on.add(l.name); if (e.lastSeen > cur.e.lastSeen) cur.e = e; }
  }
  const rows = [...byNode.values()].sort((a, b) => a.e.id.localeCompare(b.e.id));

  return (
    <div className="stack">
      <div className="strip" aria-label="Lighthouse status">
        <div className="tile" style={{ "--stripe": "var(--lh)" } as React.CSSProperties}>
          <span className="lbl">Lighthouses</span>
          <span className="val">{running}<small>of {lhs.length} running</small></span>
          <span className="det">{lhs.length ? lhs.map((l) => `udp ${l.port}`).join(" · ") : "none on this device"}</span>
        </div>
        <div className="tile" style={{ "--stripe": unique.size ? "var(--alive)" : "var(--muted)" } as React.CSSProperties}>
          <span className="lbl">Registered</span>
          <span className="val">{unique.size}<small>node{unique.size === 1 ? "" : "s"} · {devices.size} device{devices.size === 1 ? "" : "s"}</small></span>
          <span className="det">{joins} joins since start</span>
        </div>
        <div className="tile" style={{ "--stripe": rejected ? "var(--dead)" : "var(--alive)" } as React.CSSProperties}>
          <span className="lbl">Rejected packets</span>
          <span className="val" style={rejected ? { color: "var(--dead)" } : undefined}>{rejected}</span>
          <span className="det">{rejected ? "someone without the key is knocking — see the log" : "nobody is knocking with the wrong key"}</span>
        </div>
        <div className="tile" style={{ "--stripe": signing ? "var(--alive)" : "var(--dead)" } as React.CSSProperties}>
          <span className="lbl">Encryption</span>
          <span className={`val text`} style={signing ? undefined : { color: "var(--dead)" }}>{reachable.length ? (signing ? "AES-256-GCM" : "Plaintext") : "—"}</span>
          <span className="det">{reachable.length ? (signing ? "key required to join · replay window 60 s" : "anyone can join and read — set MESH_KEY") : "no reachable lighthouse"}</span>
        </div>
      </div>

      {!lhs.length && (
        <div className="panel">
          <p className="empty">This device runs no lighthouse. <b>Boot demo mesh</b> starts three, or add one in Command mode with <b>Add lighthouse</b>.
            Other devices join <i>this</i> device by putting one of its lighthouse addresses in their <code>EXTRA_LIGHTHOUSES</code>.</p>
        </div>
      )}
      {state.extraLighthouses.length > 0 && (
        <p className="muted small">External lighthouses this device joins: {state.extraLighthouses.join(", ")} — their registries live on those machines; open Lighthouse mode there to see them.</p>
      )}

      {lhs.length > 0 && (
        <div className="panel">
          <PanelHead title="Registry" sub={`what this device's lighthouses hand out · entries expire after ${Math.round(staleMs / 1000)} s of silence`}
            right={<Segmented small label="Registry view" value={view} onChange={setView} options={[{ key: "node", label: "By node" }, { key: "lighthouse", label: "By lighthouse" }]} />} />
          {view === "node" ? (
            <div style={{ overflowX: "auto" }}>
              <table className="matrix lh-table" style={{ width: "100%" }}>
                <caption>One row per registered node; the last three columns show which lighthouses hold it. Ages tick locally.</caption>
                <thead><tr>
                  <th scope="col" className="left">Node</th><th scope="col" className="left">Device</th><th scope="col" className="left">Hands out</th><th scope="col">Inc</th><th scope="col">Last seen</th>
                  {lhs.map((l) => <th key={l.name} scope="col">{l.name}</th>)}
                </tr></thead>
                <tbody>
                  {rows.map(({ e, on }) => {
                    const age = now - e.lastSeen;
                    const stale = age > 60_000;
                    const local = e.device === state.device;
                    return (
                      <tr key={e.id} style={stale ? { opacity: 0.6 } : undefined}>
                        <th scope="row"><b>{systemOf(e.id, e.service)?.short ?? e.id}</b> <span className="muted">{e.id}</span></th>
                        <td className="left">{e.device ?? "?"}{local && <> <Pill tone="info">here</Pill></>}</td>
                        <td className="left mono">{e.host}:{e.port}{e.advertise ? " ⟡" : ""}</td>
                        <td>{e.inc}</td>
                        <td className={stale ? "age-bad" : undefined}>{ago(age)}</td>
                        {lhs.map((l) => <td key={l.name}>{on.has(l.name) ? <span className="chip alive" aria-label={`registered on ${l.name}`}>✓</span> : <span className="chip unknown" aria-label={`not on ${l.name}`}>·</span>}</td>)}
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={5 + lhs.length} className="muted left">no registrations yet</td></tr>}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="lh-cards">
              {lhs.map((l) => <LighthouseCard key={l.name} lh={l} device={state.device} now={now} />)}
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <PanelHead title="Lighthouse log" sub="joins, moves, rejections"
          right={<Segmented small label="Log filter" value={logFilter} onChange={setLogFilter} options={[{ key: "all", label: "All" }, { key: "rejections", label: "Rejections" }, { key: "moves", label: "Moves" }]} />} />
        <EventLog events={events} filter={FILTERS[logFilter]} height={380} />
      </div>
    </div>
  );
}

function LighthouseCard({ lh, device, now }: { lh: LhView; device: string; now: number }) {
  const byDevice = new Map<string, number>();
  for (const e of lh.entries) byDevice.set(e.device ?? "?", (byDevice.get(e.device ?? "?") ?? 0) + 1);
  return (
    <div className="well">
      <div className="lh-card-head">
        <StatusGlyph status={lh.reachable ? "lh" : "down"} />
        <b style={{ color: "var(--lh)" }}>{lh.name}</b>
        <span className="muted">udp {lh.port}</span>
        <span className="spacer" />
        {lh.reachable
          ? <span className="muted">up {uptime(now - lh.startedAt)} · {lh.joins} joins · <span className={lh.rejected ? "age-bad" : undefined}>{lh.rejected} rejected</span></span>
          : <span className="muted">not running</span>}
      </div>
      {lh.reachable && (
        <>
          <p className="muted small" style={{ margin: "4px 0 6px" }}>
            {lh.entries.length} registered · {[...byDevice.entries()].map(([d, n]) => `${d}: ${n}`).join(" · ") || "nobody yet"}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="matrix lh-table">
              <thead><tr><th scope="col" className="left">node</th><th scope="col" className="left">device</th><th scope="col" className="left">hands out</th><th scope="col">inc</th><th scope="col">last seen</th></tr></thead>
              <tbody>
                {lh.entries.map((e) => {
                  const age = now - e.lastSeen;
                  const stale = age > 60_000;
                  return (
                    <tr key={e.id} style={stale ? { opacity: 0.6 } : undefined}>
                      <th scope="row"><b>{systemOf(e.id, e.service)?.short ?? e.id}</b> <span className="muted">{e.id}</span></th>
                      <td className="left">{e.device ?? "?"}{e.device === device && <> <Pill tone="info">here</Pill></>}</td>
                      <td className="left mono">{e.host}:{e.port}{e.advertise ? " ⟡" : ""}</td>
                      <td>{e.inc}</td>
                      <td className={stale ? "age-bad" : undefined}>{ago(age)}</td>
                    </tr>
                  );
                })}
                {!lh.entries.length && <tr><td colSpan={5} className="muted left">no registrations yet</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
