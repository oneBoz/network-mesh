import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoEntry, MeshState, NodeStatus } from "./types";
import { groupRemotes } from "./remotes";
import { api } from "./api";

const SINGAPORE: L.LatLngTuple = [1.3521, 103.8198];
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const STATUS_COLOR: Record<NodeStatus | "unknown" | "asset", string> = {
  alive: "#2dd4a7", suspect: "#f5b841", dead: "#e5484d", unknown: "#3a4a68", asset: "#8b7cf6",
};

interface Placeable {
  id: string;
  kind: GeoEntry["kind"];
  label: string;
  status: NodeStatus | "unknown" | "asset";
  sub?: string; // second line (IP, node count)
  placed?: GeoEntry;
}

/** Everything that can be on the map: this device, every remote device, every asset. */
function placeables(state: MeshState): Placeable[] {
  const out: Placeable[] = [];
  const localAlive = state.procs.some((p) => p.kind === "node" && p.running);
  if (state.device) {
    out.push({
      id: state.device, kind: "device", label: state.device, status: localAlive ? "alive" : "unknown",
      sub: "this device", placed: state.geo.entries[state.device],
    });
  }
  for (const d of groupRemotes(state.remotes)) {
    const statuses = d.members.map((m) => m.status);
    const status: NodeStatus | "unknown" = statuses.every((s) => s === "dead") ? "dead"
      : statuses.some((s) => s === "suspect") ? "suspect" : statuses.some((s) => s === "alive") ? "alive" : "unknown";
    out.push({ id: d.device, kind: "device", label: d.device, status, sub: `${d.host} · ${d.alive}/${d.members.length} alive`, placed: state.geo.entries[d.device] });
  }
  for (const [id, e] of Object.entries(state.geo.entries)) {
    if (e.kind === "asset") out.push({ id, kind: "asset", label: e.label ?? id, status: "asset", sub: "defended asset", placed: e });
  }
  return out;
}

function icon(p: Placeable, selected: boolean): L.DivIcon {
  const color = STATUS_COLOR[p.status];
  const shape = p.kind === "asset"
    ? `<div class="map-pin asset${selected ? " sel" : ""}" style="--c:${color}"><span>◆</span></div>`
    : `<div class="map-pin device${selected ? " sel" : ""}" style="--c:${color}"><span>${p.label.slice(0, 2).toUpperCase()}</span></div>`;
  return L.divIcon({ className: "", html: `${shape}<div class="map-label">${p.label}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
}

/**
 * Map of Singapore with every device and defended asset from the location
 * table. In Command mode ("editable") the operator places things: pick an
 * item in the side list (or type a new asset name), click the map; drag a
 * marker to move it; × removes an asset. Every edit goes to PUT /api/geo/<id>,
 * which persists it and broadcasts the table to the whole mesh.
 */
export function MapPanel({ state, editable, height = 340, onError }: {
  state: MeshState; editable: boolean; height?: number; onError?: (m: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newAsset, setNewAsset] = useState("");
  const [offline, setOffline] = useState(false);
  const items = placeables(state);
  const selectedRef = useRef<{ id: string; kind: GeoEntry["kind"]; label?: string } | null>(null);

  // Create the map once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: SINGAPORE, zoom: 11, zoomControl: true, attributionControl: true });
    const tiles = L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 18 });
    tiles.on("tileerror", () => setOffline(true));
    tiles.on("tileload", () => setOffline(false));
    tiles.addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => {
      const sel = selectedRef.current;
      if (!sel) return;
      api.placeGeo(sel.id, { kind: sel.kind, lat: e.latlng.lat, lng: e.latlng.lng, label: sel.label })
        .catch((err: Error) => onError?.(err.message));
      selectedRef.current = null;
      setSelected(null);
      setNewAsset("");
    });
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  // Redraw markers whenever the table or statuses change.
  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    for (const p of items) {
      if (!p.placed) continue;
      const mk = L.marker([p.placed.lat, p.placed.lng], { icon: icon(p, selected === p.id), draggable: editable, title: p.label });
      mk.bindTooltip(`<b>${p.label}</b>${p.sub ? `<br>${p.sub}` : ""}<br>${p.placed.lat.toFixed(4)}, ${p.placed.lng.toFixed(4)}`, { direction: "top", offset: [0, -14] });
      if (editable) {
        mk.on("dragend", () => {
          const ll = mk.getLatLng();
          api.placeGeo(p.id, { kind: p.kind, lat: ll.lat, lng: ll.lng, label: p.kind === "asset" ? p.label : undefined })
            .catch((err: Error) => onError?.(err.message));
        });
      }
      mk.addTo(g);
    }
  }, [state.geo.version, state.remotes, state.procs, selected, editable]);

  const pick = (id: string, kind: GeoEntry["kind"], label?: string) => {
    if (!editable) return;
    if (selected === id) { setSelected(null); selectedRef.current = null; return; }
    setSelected(id);
    selectedRef.current = { id, kind, label };
  };

  const startNewAsset = () => {
    const name = newAsset.trim();
    if (!name) return;
    const id = `asset-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
    pick(id, "asset", name);
  };

  const unplaced = items.filter((p) => !p.placed && p.kind === "device");

  return (
    <div className="panel map-panel">
      <h2>
        Map — Singapore
        {state.geo.version > 0 && (
          <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>
            table v{state.geo.version} by {state.geo.updatedBy}
          </span>
        )}
        {offline && <span className="remote-tag" style={{ marginLeft: 8, color: "var(--suspect)", background: "rgba(245,184,65,.15)" }}>tiles offline</span>}
      </h2>
      <div className="map-row">
        <div ref={el} className="map" style={{ height }} />
        {editable && (
          <div className="map-side">
            <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
              {selected ? "click the map to place it · click again to cancel" : "pick an item, then click the map · drag markers to move"}
            </div>
            {items.filter((p) => p.kind === "device").map((p) => (
              <button key={p.id} className={`map-item${selected === p.id ? " on" : ""}`} onClick={() => pick(p.id, "device")}>
                <span className="dot" style={{ background: STATUS_COLOR[p.status] }} />
                <span className="map-item-name">{p.label}</span>
                <span className="muted">{p.placed ? "placed" : "unplaced"}</span>
              </button>
            ))}
            <div className="muted" style={{ fontSize: 11, margin: "8px 0 4px" }}>defended assets</div>
            {items.filter((p) => p.kind === "asset").map((p) => (
              <div key={p.id} className={`map-item${selected === p.id ? " on" : ""}`}>
                <button style={{ all: "unset", cursor: "pointer", display: "flex", gap: 6, alignItems: "center", flex: 1 }} onClick={() => pick(p.id, "asset", p.label)}>
                  <span className="dot" style={{ background: STATUS_COLOR.asset }} />
                  <span className="map-item-name">{p.label}</span>
                </button>
                <button className="danger" style={{ padding: "0 6px" }} title="remove asset"
                  onClick={() => api.removeGeo(p.id).catch((err: Error) => onError?.(err.message))}>×</button>
              </div>
            ))}
            <div className="row" style={{ marginTop: 6 }}>
              <input size={12} placeholder="new asset, e.g. Changi" value={newAsset}
                onChange={(e) => setNewAsset(e.target.value)} onKeyDown={(e) => e.key === "Enter" && startNewAsset()} />
              <button onClick={startNewAsset} disabled={!newAsset.trim()}>+ place</button>
            </div>
            {unplaced.length > 0 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                {unplaced.length} device{unplaced.length === 1 ? "" : "s"} not on the map yet
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
