import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoEntry, MeshState, NodeStatus, TrackView } from "./types";
import { groupRemotes } from "./remotes";
import { api } from "./api";

const SINGAPORE: L.LatLngTuple = [1.3521, 103.8198];
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const STATUS_COLOR: Record<NodeStatus | "unknown" | "asset", string> = {
  alive: "#2dd4a7", suspect: "#f5b841", dead: "#e5484d", unknown: "#3a4a68", asset: "#8b7cf6",
};
const THREAT_COLOR: Record<string, string> = { missile: "#ff6b6b", swarm: "#f5b841", aircraft: "#5eead4", emp: "#c4b5fd" };
const THREAT_GLYPH: Record<string, string> = { missile: "▲", swarm: "✱", aircraft: "✈", emp: "⚡" };
const RECENT_MS = 90_000; // finished tracks stay on the map this long
const BASEMAP_KEY = "mesh-map-basemap";
/** "auto": OpenStreetMap tiles, with the bundled island drawn beneath them as soon as a tile
 *  fails to load. "offline": the bundled basemap only — the page makes no network request. */
type Basemap = "auto" | "offline";
const LABEL_ZOOM = 12; // planning-area names appear from this zoom in

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
export function MapPanel({ state, editable, height = 340, onError, pickOrigin, onPickOrigin }: {
  state: MeshState; editable: boolean; height?: number; onError?: (m: string) => void;
  /** When set, the next map click is reported here (GCS scenario launcher) instead of placing. */
  pickOrigin?: boolean; onPickOrigin?: (p: { lat: number; lng: number }) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const trackLayer = useRef<L.LayerGroup | null>(null);
  const pickRef = useRef<{ on: boolean; cb?: (p: { lat: number; lng: number }) => void }>({ on: false });
  pickRef.current = { on: !!pickOrigin, cb: onPickOrigin };
  const [selected, setSelected] = useState<string | null>(null);
  const [newAsset, setNewAsset] = useState("");
  const [offline, setOffline] = useState(false); // a tile failed to load
  const [basemap, setBasemap] = useState<Basemap>(() => {
    try { return localStorage.getItem(BASEMAP_KEY) === "offline" ? "offline" : "auto"; } catch { return "auto"; }
  });
  const [zoomLo, setZoomLo] = useState(true);
  const tiles = useRef<L.TileLayer | null>(null);
  const fallback = useRef<L.GeoJSON | null>(null);
  const drawn = basemap === "offline" || offline; // the bundled basemap is (or is about to be) on screen
  const items = placeables(state);
  const selectedRef = useRef<{ id: string; kind: GeoEntry["kind"]; label?: string } | null>(null);

  // Create the map once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: SINGAPORE, zoom: 11, zoomControl: true, attributionControl: true });
    // Tiles live in Leaflet's tilePane (z-index 200). The bundled basemap goes
    // in a pane beneath them, so a tile that fails to load (transparent)
    // reveals the drawn island while a tile that loads covers it — patchy
    // connectivity needs no special handling. The basemap effect below adds it.
    m.createPane("basemap").style.zIndex = "150";
    const t = L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 18 });
    t.on("tileerror", () => setOffline(true));
    t.on("tileload", () => setOffline(false));
    tiles.current = t;
    m.on("zoomend", () => setZoomLo(m.getZoom() < LABEL_ZOOM));
    setZoomLo(m.getZoom() < LABEL_ZOOM);
    layer.current = L.layerGroup().addTo(m);
    trackLayer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => {
      if (pickRef.current.on) { pickRef.current.cb?.({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
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

  // Basemap mode. The bundled GeoJSON (~60 KB, src/basemap/) is a separate
  // chunk fetched from our own origin on first need, so it works with no internet.
  useEffect(() => {
    try { localStorage.setItem(BASEMAP_KEY, basemap); } catch { /* ignore */ }
    const m = map.current, t = tiles.current;
    if (!m || !t) return;
    if (basemap === "offline") { if (m.hasLayer(t)) m.removeLayer(t); }
    else if (!m.hasLayer(t)) t.addTo(m);
    if (!drawn || fallback.current) return;
    let cancelled = false;
    void import("./basemap/singapore.geo.json").then(({ default: data }) => {
      if (cancelled || fallback.current || !map.current) return;
      fallback.current = L.geoJSON(data, {
        pane: "basemap",
        attribution: data.attribution,
        style: { color: "#2b4d73", weight: 1, fillColor: "#182741", fillOpacity: 1 },
        onEachFeature: (f, lyr) => lyr.bindTooltip(String(f.properties?.name ?? ""), { permanent: true, direction: "center", className: "pa-label" }),
      }).addTo(map.current);
    }).catch((err: Error) => onError?.(`offline basemap failed to load: ${err.message}`));
    return () => { cancelled = true; };
  }, [basemap, drawn]);

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

  // Trajectories: polyline + heading arrow at the head, label with state and ETA,
  // dashed line to the target, ✖ at impact. Marker moves are CSS-transitioned
  // (see styles) so 1 Hz updates look continuous.
  useEffect(() => {
    const g = trackLayer.current;
    if (!g) return;
    g.clearLayers();
    const now = Date.now();
    for (const t of state.tracks) {
      if (!t.positions.length) continue;
      const finishedAt = t.neutralised?.at ?? t.lostAt ?? t.impactAt;
      if (finishedAt && now - finishedAt > RECENT_MS) continue;
      const live = t.state === "detected" || t.state === "engaging";
      const color = THREAT_COLOR[t.threat] ?? "#fff";
      const pts = t.positions.map((p) => [p.lat, p.lng] as L.LatLngTuple);
      const head = t.positions[t.positions.length - 1];
      L.polyline(pts, { color, weight: live ? 2.5 : 1.5, opacity: live ? 0.9 : 0.4, dashArray: live ? undefined : "4 6" }).addTo(g);
      const target = t.target ? state.geo.entries[t.target] : undefined;
      if (target && live) L.polyline([[head.lat, head.lng], [target.lat, target.lng]], { color, weight: 1, opacity: 0.35, dashArray: "2 8" }).addTo(g);
      const eta = head.eta !== undefined && live ? ` · ETA ${Math.max(0, Math.round(head.eta / 1000))}s` : "";
      const stateTxt = t.state === "neutralised" ? "✔ NEUTRALISED" : t.state === "impact" ? "✖ IMPACT" : t.state === "lost" ? "lost" : t.state === "engaging" ? "engaging" : "inbound";
      const rot = head.heading ?? 0;
      const html = t.state === "impact"
        ? `<div class="track-head impact" style="--c:${color}">✖</div>`
        : t.state === "neutralised"
          ? `<div class="track-head done" style="--c:${color}">✔</div>`
          : `<div class="track-head${live ? " live" : ""}" style="--c:${color};transform:rotate(${rot}deg)">${THREAT_GLYPH[t.threat] ?? "●"}</div>`;
      const mk = L.marker([head.lat, head.lng], {
        icon: L.divIcon({ className: "track-icon", html: `${html}<div class="track-label" style="--c:${color}">${t.threat.toUpperCase()} ${stateTxt}${eta}<br><span>→ ${t.target ? (state.geo.entries[t.target]?.label ?? t.target) : "?"} · ${t.responsibleDevice ?? "nobody"}</span></div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
        interactive: true, zIndexOffset: 500,
      });
      mk.bindTooltip(`<b>${t.threat}</b> ${t.trackId}<br>from ${t.origin.station ?? t.origin.node}@${t.origin.device ?? "?"}<br>state: ${t.state}<br>responsible: ${t.responsibleDevice ?? "nobody"} (${t.responsibleNode ?? "-"})<br>${t.positions.length} positions${head.speed ? `, ${Math.round(head.speed * 3.6)} km/h` : ""}`, { direction: "top", offset: [0, -12] });
      mk.addTo(g);
      if (pts.length > 1) L.circleMarker(pts[0], { radius: 3, color, fillColor: color, fillOpacity: 0.8, weight: 1 }).addTo(g); // origin dot
    }
  }, [state.tracks, state.geo.version]);

  const fitAll = () => {
    const m = map.current;
    if (!m) return;
    const pts: L.LatLngTuple[] = [];
    for (const e of Object.values(state.geo.entries)) pts.push([e.lat, e.lng]);
    for (const t of state.tracks) for (const p of t.positions) pts.push([p.lat, p.lng]);
    if (pts.length >= 2) m.fitBounds(L.latLngBounds(pts).pad(0.15), { animate: true });
    else if (pts.length === 1) m.setView(pts[0], 12);
    else m.setView(SINGAPORE, 11);
  };

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
        {basemap === "offline" ? (
          <span className="remote-tag" style={{ marginLeft: 8 }}>bundled basemap · no network</span>
        ) : offline && (
          <span className="remote-tag" style={{ marginLeft: 8, color: "var(--suspect)", background: "rgba(245,184,65,.15)" }}>tiles unreachable → bundled basemap</span>
        )}
        {pickOrigin && <span className="remote-tag" style={{ marginLeft: 8, color: "var(--suspect)", background: "rgba(245,184,65,.15)" }}>click the map: launch origin</span>}
        <button className="map-fit" style={{ marginLeft: "auto" }}
          title={basemap === "auto" ? "stop loading OpenStreetMap tiles and draw the bundled Singapore basemap — works with no internet" : "load OpenStreetMap tiles again when reachable"}
          onClick={() => setBasemap((b) => (b === "auto" ? "offline" : "auto"))}>
          {basemap === "auto" ? "🗺 offline map" : "🌐 online tiles"}
        </button>
        <button className="map-fit" style={{ marginLeft: 6 }} title="fit the map to every device, asset and trajectory" onClick={fitAll}>⤢ fit</button>
      </h2>
      <div className="map-row">
        {/* Leaflet owns the inner div's classes; React owns the wrapper's, so toggling ours never wipes Leaflet's. */}
        <div className={`map${pickOrigin ? " picking" : ""}${drawn ? " drawn" : ""}${zoomLo ? " zoom-lo" : ""}`} style={{ height }}>
          <div ref={el} style={{ height: "100%" }} />
        </div>
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
            <button style={{ marginTop: 8 }} title="place the demo assets (Changi and Paya Lebar airbases, Tuas Port, Jurong Island, Sembawang, Marina Bay) and every device not on the map yet — one click to a demo-ready map"
              onClick={() => api.seedGeo().catch((err: Error) => onError?.(err.message))}>
              ⊕ seed Singapore demo layout
            </button>
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
