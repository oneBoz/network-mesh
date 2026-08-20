import type { MeshState } from "./types";

const LETTER = { alive: "A", suspect: "S", dead: "D" } as const;

/**
 * Rows = observers, columns = subjects: what every node believes about every
 * other node, straight from each node's own /members API. When all columns
 * agree the mesh has converged; after a kill or partition you can watch
 * disagreement spread and then heal.
 */
export function ConvergenceMatrix({ state }: { state: MeshState }) {
  const nodeIds = state.procs.filter((p) => p.kind === "node").map((p) => p.name);
  if (nodeIds.length === 0) return null;

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="matrix">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>sees →</th>
            {nodeIds.map((id) => <th key={id}>{id}</th>)}
          </tr>
        </thead>
        <tbody>
          {state.views.map((v) => (
            <tr key={v.id} className={v.reachable ? "" : "observer-down"}>
              <th style={{ textAlign: "left" }}>{v.id}</th>
              {nodeIds.map((subject) => {
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
    </div>
  );
}
