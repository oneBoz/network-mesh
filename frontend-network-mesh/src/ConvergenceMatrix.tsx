import type { MeshState } from "./types";
import { remoteDevice } from "./remotes";

const LETTER = { alive: "A", suspect: "S", dead: "D" } as const;

/**
 * Rows = observers, columns = subjects: what every node believes about every
 * other node, straight from each node's own /members API. When all columns
 * agree the mesh has converged; after a kill or partition you can watch
 * disagreement spread and then heal.
 *
 * Remote members (nodes on other machines, learned via gossip) are extra
 * columns: local observers have an opinion about them, but they are not
 * observers themselves because the dashboard never polls another machine.
 */
export function ConvergenceMatrix({ state }: { state: MeshState }) {
  const nodeIds = state.procs.filter((p) => p.kind === "node").map((p) => p.name);
  const remotes = state.remotes;
  if (nodeIds.length === 0 && remotes.length === 0) return null;

  const subjects = [
    ...nodeIds.map((id) => ({ id, remote: undefined as string | undefined, device: undefined as string | undefined, host: undefined as string | undefined })),
    ...remotes.map((r) => ({ id: r.id, remote: `${remoteDevice(r)} · ${r.host}:${r.port}`, device: remoteDevice(r), host: r.host })),
  ];

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="matrix">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>sees →</th>
            {subjects.map((s) => (
              <th key={s.id} className={s.remote ? "remote-col" : undefined}
                title={s.remote ? `remote member on another machine · ${s.remote}` : undefined}>
                {s.id}{s.remote ? " ⟡" : ""}
                {s.remote && <div className="matrix-sub">{s.device}<br />{s.host}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.views.map((v) => (
            <tr key={v.id} className={v.reachable ? "" : "observer-down"}>
              <th style={{ textAlign: "left" }}>{v.id}</th>
              {subjects.map(({ id: subject }) => {
                if (subject === v.id) {
                  return (
                    <td key={subject}>
                      <span className="chip alive" title={`self, incarnation ${v.inc}`}>
                        {v.reachable ? `A${v.inc > 0 ? `·${v.inc}` : ""}` : "?"}
                      </span>
                    </td>
                  );
                }
                const e = v.view[subject];
                return (
                  <td key={subject}>
                    {e && v.reachable ? (
                      <span className={`chip ${e.status}`} title={`incarnation ${e.inc}`}>
                        {LETTER[e.status]}{e.inc > 0 ? `·${e.inc}` : ""}
                      </span>
                    ) : (
                      <span className="chip unknown">·</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {remotes.length > 0 && (
        <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 6 }}>
          ⟡ remote member on another machine — rows are local observers only; the dashboard never polls across the internet.
        </div>
      )}
    </div>
  );
}
