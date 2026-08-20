import { useState } from "react";
import { api } from "./api";
import type { MeshState } from "./types";
import { DEFENSE_SYSTEMS, defenseTooltip } from "./defense";

/** Fleet controls: add servers, crash them, revive them. */
export function ProcPanel({ state, onError }: { state: MeshState; onError: (m: string) => void }) {
  const [newId, setNewId] = useState("");
  const [newService, setNewService] = useState("");

  const run = (p: Promise<unknown>) => p.catch((e: Error) => onError(e.message));

  return (
    <div className="panel">
      <h2>Fleet</h2>
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
          <div className="proc" key={p.name} title={defenseTooltip(p.name)}>
            <span className="dot" style={{
              background: p.running ? "var(--alive)" : "var(--dead)",
            }} />
            <span className="name" style={p.kind === "lighthouse" ? { color: "var(--lh)" } : {}}>
              {DEFENSE_SYSTEMS[p.name]?.name ?? p.name}
            </span>
            <span className="meta">
              {DEFENSE_SYSTEMS[p.name] ? `${DEFENSE_SYSTEMS[p.name].layer} · ` : ""}
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
    </div>
  );
}
