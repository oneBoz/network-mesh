import { useEffect, useState } from "react";
import type { MeshState, ThreatAssignmentEvent } from "./types";
import { MapPanel } from "./MapPanel";
import { TopologyGraph } from "./TopologyGraph";
import { PanelHead, Segmented } from "./ui";

const VIEW_KEY = "mesh-situation-view";

/** Map and topology behind one segmented control. The map is the default (trajectories are the
 *  demo's climax); the topology is for checking status. Both stay mounted so Leaflet keeps its
 *  zoom and the graph its drag state; the hidden one just does not paint. */
export function SituationPanel({ state, activeThreat, onError }: { state: MeshState; activeThreat: ThreatAssignmentEvent | null; onError: (m: string) => void }) {
  const [view, setView] = useState<"map" | "topology">(() => {
    try { return localStorage.getItem(VIEW_KEY) === "topology" ? "topology" : "map"; } catch { return "map"; }
  });
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);
  return (
    <div className="panel">
      <PanelHead title="Situation" sub={view === "map" ? "Singapore · devices, assets, trajectories" : "consensus view · what the mesh believes"}>
        <Segmented small label="Situation view" value={view} onChange={setView} options={[{ key: "map", label: "Map" }, { key: "topology", label: "Topology" }]} />
      </PanelHead>
      <div hidden={view !== "map"}><MapPanel state={state} editable height={470} onError={onError} visible={view === "map"} /></div>
      <div hidden={view !== "topology"}><TopologyGraph state={state} activeThreat={activeThreat} /></div>
    </div>
  );
}
