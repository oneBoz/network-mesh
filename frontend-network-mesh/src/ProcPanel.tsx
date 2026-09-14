import { useState } from "react";
import { api } from "./api";
import type { MeshState, NodeStatus } from "./types";
import { defenseTooltip, systemOf } from "./defense";
import { groupRemotes } from "./remotes";

const STATUS_COLOR: Record<NodeStatus, string> = {
  alive: "var(--alive)", suspect: "var(--suspect)", dead: "var(--dead)",
};

/** Fleet controls: add servers, crash them, revive them — plus a read-only
 *  list of members on other machines (you cannot crash someone else's process). */
export function ProcPanel({ state, onError }: { state: MeshState; onError: (m: string) => void }) {
  const [newId, setNewId] = useState("");
  const [newService, setNewService] = useState("");

  const run = (p: Promise<unknown>) => p.catch((e: Error) => onError(e.message));
  const observers = state.views.filter((v) => v.reachable).length;
  const hasRemoteSection = state.remotes.length > 0 || state.extraLighthouses.length > 0;

  return (
    <div className="panel">
      <h2>This device</h2>
      <div className="row" style={{ marginBottom: 6 }}>
        <input placeholder="id (auto)" size={7} value={newId}
          onChange={(e) => setNewId(e.target.value)} />
        <input placeholder="service e.g. aegis" size={11} value={newService}
          onChange={(e) => setNewService(e.target.value)} />
        <button onClick={() => {
          run(api.addNode(newId || undefined, newService || undefined));
          setNewId("");
          setNewService("");
        }}>+ Node</button>
        <button onClick={() => run(api.addLighthouse())}>+ Lighthouse</button>
      </div>

      <div className="proc-list">
        {state.procs.map((p) => (
          <div className="proc" key={p.name} title={defenseTooltip(p.name, p.service)}>
            <span className="dot" style={{
              background: p.running ? "var(--alive)" : "var(--dead)",
            }} />
            <span className="name" style={p.kind === "lighthouse" ? { color: "var(--lh)" } : {}}>
              {systemOf(p.name, p.service)?.name ?? p.name}
            </span>
            <span className="meta">
              {systemOf(p.name, p.service) ? `${systemOf(p.name, p.service)!.layer} · ` : ""}
              {p.kind === "node" && systemOf(p.name, p.service) && p.name !== p.service ? `${p.name} · ` : ""}
              {p.kind === "lighthouse"
                ? `udp/${p.port}`
                : `udp/${p.port} http/${p.httpPort}${p.service ? ` · ${p.service}` : ""}`}
              {p.pid && p.running ? ` · pid ${p.pid}` : ""}
            </span>
            {p.running ? (
              <button className="danger" onClick={() => run(api.kill(p.name))}>kill</button>
            ) : (
              <button onClick={() => run(api.revive(p.name))}>revive</button>
            )}
            <button className="danger" title="kill and forget"
              onClick={() => run(api.remove(p.name))}>×</button>
          </div>
        ))}
        {!state.procs.length && (
          <div style={{ color: "var(--muted)", padding: "6px 2px" }}>
            Nothing running. Boot the demo or add servers above.
          </div>
        )}
      </div>

      {hasRemoteSection && (
        <>
          <h2 style={{ marginTop: 14 }}>
            Other devices <span className="remote-tag">via internet</span>
          </h2>
          <div className="proc-list">
            {state.extraLighthouses.map((addr) => (
              <div className="proc remote" key={`xlh-${addr}`}
                title="External lighthouse (EXTRA_LIGHTHOUSES): every local node joins it too, so this fleet merges with peers that use the same lighthouse">
                <span className="dot" style={{ background: "var(--lh)" }} />
                <span className="name" style={{ color: "var(--lh)" }}>lighthouse</span>
                <span className="meta">{addr} · external join broker</span>
              </div>
            ))}
            {groupRemotes(state.remotes).map((d) => (
              <div className="device-group" key={d.device}>
                <div className="device-head" title={`${d.members.length} node${d.members.length === 1 ? "" : "s"} reached at ${d.host}`}>
                  <span className="device-name">⟡ {d.device}</span>
                  <span className="device-ip">{d.host}</span>
                  <span className="muted">{d.alive}/{d.members.length} alive</span>
                </div>
                {d.members.map((r) => (
                  <div className="proc remote" key={r.id}
                    title={`${defenseTooltip(r.id, r.service) ?? r.id}\non ${d.device} at ${r.host}:${r.port}\nlearned through gossip · incarnation ${r.inc} · votes alive ${r.votes.alive} / suspect ${r.votes.suspect} / dead ${r.votes.dead}`}>
                    <span className="dot" style={{ background: STATUS_COLOR[r.status] }} />
                    <span className="name">{systemOf(r.id, r.service)?.name ?? r.id}</span>
                    <span className="meta">
                      {r.id} · udp/{r.port}
                      {" · "}<span style={{ color: STATUS_COLOR[r.status] }}>{r.status}</span>
                      {` · seen by ${r.observers}/${observers}`}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {!state.remotes.length && (
              <div style={{ color: "var(--muted)", padding: "6px 2px", fontSize: 12 }}>
                No remote peers yet — they appear here when a node on another machine joins the lighthouse above.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
