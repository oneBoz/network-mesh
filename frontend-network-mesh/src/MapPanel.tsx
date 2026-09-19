import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoEntry, MeshState, NodeStatus, TrackView } from "./types";
import { deviceStatus, groupRemotes } from "./remotes";
import { api } from "./api";
import { Field, Pill, StatusGlyph } from "./ui";

const SINGAPORE: L.LatLngTuple = [1.3521, 103.8198];
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const STATUS_COLOR: Record<NodeStatus | "unknown" | "asset", string> = {
  alive: "#3dd9a4", suspect: "#f2b33d", dead: "#f47174", unknown: "#9aa7bd", asset: "#afa3fb",
};
const THREAT_COLOR: Record<string, string> = { missile: "#ee86cb", swarm: "#f2b33d", aircraft: "#7dd3fc", emp: "#c4b5fd" };
const THREAT_GLYPH: Record<string, string> = { missile: "▲", swarm: "✱", aircraft: "✈", emp: "⚡" };
const RECENT_MS = 90_000; // finished tracks stay on the map this long
const BASEMAP_KEY = "mesh-map-basemap";
/** "auto": OpenStreetMap tiles, with the bundled island drawn beneath them as soon as a tile
 *  fails to load. "offline": the bundled basemap only — the page makes no network request. */
type Basemap = "auto" | "offline";
const LABEL_ZOOM = 12; // planning-area names appear from this zoom in

/** The Leaflet layers of one drawn track, reused across updates. */
interface TrackLayers { line: L.Polyline; toTarget: L.Polyline; head: L.Marker; origin: L.CircleMarker; html: string }

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
    out.push({ id: d.device, kind: "device", label: d.device, status: deviceStatus(d), sub: `${d.host} · ${d.alive}/${d.members.length} alive`, placed: state.geo.entries[d.device] });
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
    : `<div class="map-pin device${p.status === "dead" ? " down" : ""}${selected ? " sel" : ""}" style="--c:${color}"><span>${p.status === "dead" ? "" : p.label.slice(0, 2).toUpperCase()}</span></div>`;
  return L.divIcon({ className: "", html: `${shape}<div class="map-label">${p.label}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
}

/**
 * Map of Singapore with every device and defended asset from the location
 * table. In Command mode ("editable") the operator places things: pick an
 * item in the side list (or name a new asset), click the map; drag a marker
 * to move it; remove an asset from the list. Every edit goes to PUT /api/geo/<id>,
 * which persists it and broadcasts the table to the whole mesh. The panel
 * chrome (title, toolbar) is the caller's; this renders the map block only.
 */
export function MapPanel({ state, editable, height = 340, onError, pickOrigin, onPickOrigin, visible = true }: {
  state: MeshState; editable: boolean; height?: number; onError?: (m: string) => void;
  /** When set, the next map click is reported here (GCS scenario launcher) instead of placing. */
  pickOrigin?: boolean; onPickOrigin?: (p: { lat: number; lng: number }) => void;
  /** False while the map is hidden behind another tab; Leaflet re-measures when it comes back. */
  visible?: boolean;
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
  const markers = useRef(new Map<string, L.Marker>());
  const trackLayers = useRef(new Map<string, TrackLayers>());

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
    return () => { m.remove(); map.current = null; markers.current.clear(); trackLayers.current.clear(); };
  }, []);

  // Shown again after being hidden behind the topology tab: Leaflet must re-measure its container.
  useEffect(() => { if (visible) map.current?.invalidateSize(); }, [visible]);

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

  // Markers: one per placed item, kept across renders and updated in place.
  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    const seen = new Set<string>();
    for (const p of items) {
      if (!p.placed) continue;
      seen.add(p.id);
      const at: L.LatLngTuple = [p.placed.lat, p.placed.lng];
      const ic = icon(p, selected === p.id);
      const tip = `<b>${p.label}</b>${p.sub ? `<br>${p.sub}` : ""}<br>${p.placed.lat.toFixed(4)}, ${p.placed.lng.toFixed(4)}`;
      let mk = markers.current.get(p.id);
      if (!mk) {
        mk = L.marker(at, { icon: ic, draggable: editable, title: p.label }).bindTooltip(tip, { direction: "top", offset: [0, -14] }).addTo(g);
        markers.current.set(p.id, mk);
      } else {
        const cur = mk.getLatLng();
        if (cur.lat !== at[0] || cur.lng !== at[1]) mk.setLatLng(at);
        if ((mk.getIcon() as L.DivIcon).options.html !== ic.options.html) mk.setIcon(ic);
        mk.setTooltipContent(tip);
      }
      if (editable) {
        const marker = mk;
        marker.off("dragend").on("dragend", () => {
          const ll = marker.getLatLng();
          api.placeGeo(p.id, { kind: p.kind, lat: ll.lat, lng: ll.lng, label: p.kind === "asset" ? p.label : undefined })
            .catch((err: Error) => onError?.(err.message));
        });
      }
    }
    for (const [id, mk] of markers.current) {
      if (seen.has(id)) continue;
      g.removeLayer(mk);
      markers.current.delete(id);
    }
  }, [state.geo.version, state.remotes, state.procs, selected, editable]);

  // Trajectories: polyline + heading arrow at the head, label with state and ETA,
  // dashed line to the target, ✖ at impact. Layers are kept per track and
  // updated in place: the head marker's element survives each 1 Hz update, so
  // the CSS transition on its transform (see styles) makes the motion continuous.
  useEffect(() => {
    const g = trackLayer.current;
    if (!g) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const t of state.tracks) {
      if (!t.positions.length) continue;
      const finishedAt = t.neutralised?.at ?? t.lostAt ?? t.impactAt;
      if (finishedAt && now - finishedAt > RECENT_MS) continue;
      seen.add(t.trackId);
      const live = t.state === "detected" || t.state === "engaging";
      const color = THREAT_COLOR[t.threat] ?? "#fff";
      const pts = t.positions.map((p) => [p.lat, p.lng] as L.LatLngTuple);
      const head = t.positions[t.positions.length - 1];
      const target = t.target ? state.geo.entries[t.target] : undefined;
      const eta = head.eta !== undefined && live ? ` · ETA ${Math.max(0, Math.round(head.eta / 1000))} s` : "";
      const stateTxt = t.state === "neutralised" ? "✔ neutralised" : t.state === "impact" ? "✖ impact" : t.state === "lost" ? "lost" : t.state === "engaging" ? "engaging" : "inbound";
      const rot = head.heading ?? 0;
      const glyph = t.state === "impact"
        ? `<div class="track-head impact" style="--c:${color}">✖</div>`
        : t.state === "neutralised"
          ? `<div class="track-head done" style="--c:${color}">✔</div>`
          : `<div class="track-head${live ? " live" : ""}" style="--c:${color};transform:rotate(${rot}deg)">${THREAT_GLYPH[t.threat] ?? "●"}</div>`;
      const html = `${glyph}<div class="track-label" style="--c:${color}">${t.threat.toUpperCase()} ${stateTxt}${eta}<br><span>→ ${t.target ? (state.geo.entries[t.target]?.label ?? t.target) : "?"} · ${t.responsibleDevice ?? "nobody"}</span></div>`;
      const tip = `<b>${t.threat}</b> ${t.trackId}<br>from ${t.origin.station ?? t.origin.node}@${t.origin.device ?? "?"}<br>state: ${t.state}<br>responsible: ${t.responsibleDevice ?? "nobody"} (${t.responsibleNode ?? "-"})<br>${t.positions.length} positions${head.speed ? `, ${Math.round(head.speed * 3.6)} km/h` : ""}`;
      const lineStyle = { color, weight: live ? 2.5 : 1.5, opacity: live ? 0.9 : 0.4, dashArray: live ? undefined : "4 6" };
      let tl = trackLayers.current.get(t.trackId);
      if (!tl) {
        tl = {
          line: L.polyline(pts, lineStyle).addTo(g),
          toTarget: L.polyline([], { color, weight: 1, opacity: 0.35, dashArray: "2 8" }).addTo(g),
          head: L.marker([head.lat, head.lng], {
            icon: L.divIcon({ className: "track-icon", html, iconSize: [24, 24], iconAnchor: [12, 12] }),
            interactive: true, zIndexOffset: 500,
          }).bindTooltip(tip, { direction: "top", offset: [0, -12] }).addTo(g),
          origin: L.circleMarker(pts[0], { radius: 3, color, fillColor: color, fillOpacity: 0.8, weight: 1 }), // added once there is a trail
          html,
        };
        trackLayers.current.set(t.trackId, tl);
      } else {
        tl.line.setLatLngs(pts);
        tl.line.setStyle(lineStyle);
        tl.head.setLatLng([head.lat, head.lng]);
        if (tl.html !== html) {
          const el2 = tl.head.getElement();
          if (el2) el2.innerHTML = html; // in place: the element (and its transition) survive
          tl.html = html;
        }
        tl.head.setTooltipContent(tip);
      }
      tl.toTarget.setLatLngs(target && live ? [[head.lat, head.lng], [target.lat, target.lng]] : []);
      if (pts.length > 1 && !g.hasLayer(tl.origin)) tl.origin.addTo(g);
    }
    for (const [id, tl] of trackLayers.current) {
      if (seen.has(id)) continue;
      for (const l of [tl.line, tl.toTarget, tl.head, tl.origin]) g.removeLayer(l);
      trackLayers.current.delete(id);
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
  const devices = items.filter((p) => p.kind === "device");
  const assets = items.filter((p) => p.kind === "asset");

  return (
    <div className="map-block">
      <div className="map-toolbar">
        {state.geo.version > 0 && <span className="muted small">table v{state.geo.version} by {state.geo.updatedBy}</span>}
        {basemap === "offline" ? <Pill tone="lh">bundled basemap · no network</Pill> : offline && <Pill tone="warn">tiles unreachable → bundled basemap</Pill>}
        {pickOrigin && <Pill tone="warn">click the map to set the launch origin</Pill>}
        {selected && editable && <Pill tone="info">click the map to place {items.find((p) => p.id === selected)?.label ?? selected} · click it again to cancel</Pill>}
        <span className="spacer" />
        <button type="button" className="btn sm quiet" aria-pressed={basemap === "offline"}
          title={basemap === "auto" ? "Stop loading OpenStreetMap tiles and draw the bundled Singapore basemap — works with no internet" : "Load OpenStreetMap tiles again when reachable"}
          onClick={() => setBasemap((b) => (b === "auto" ? "offline" : "auto"))}>
          {basemap === "auto" ? "Offline basemap" : "Online tiles"}
        </button>
        <button type="button" className="btn sm quiet" title="Fit the map to every device, asset and trajectory" onClick={fitAll}>Fit</button>
      </div>
      <div className="map-row">
        {/* Leaflet owns the inner div's classes; React owns the wrapper's, so toggling ours never wipes Leaflet's. */}
        <div className={`map${pickOrigin ? " picking" : ""}${drawn ? " drawn" : ""}${zoomLo ? " zoom-lo" : ""}`} style={{ height }}>
          <div ref={el} style={{ height: "100%" }} aria-label="Map of Singapore" role="application" />
        </div>
        {editable && (
          <div className="map-side">
            <span className="lbl" style={{ marginTop: 0 }}>Devices</span>
            {devices.map((p) => (
              <button type="button" key={p.id} className={`map-item${selected === p.id ? " on" : ""}`} aria-pressed={selected === p.id} onClick={() => pick(p.id, "device")}>
                <StatusGlyph status={p.status === "asset" ? "unknown" : p.status} />
                <span className="map-item-name">{p.label}</span>
                <span className="muted">{p.placed ? "placed" : "unplaced"}</span>
              </button>
            ))}
            <span className="lbl">Defended assets</span>
            {assets.map((p) => (
              <div key={p.id} className={`map-item${selected === p.id ? " on" : ""}`}>
                <button type="button" style={{ all: "unset", cursor: "pointer", display: "flex", gap: 6, alignItems: "center", flex: 1, minWidth: 0 }} aria-pressed={selected === p.id} onClick={() => pick(p.id, "asset", p.label)}>
                  <StatusGlyph status="asset" />
                  <span className="map-item-name">{p.label}</span>
                </button>
                <button type="button" className="icon-btn" aria-label={`Remove ${p.label}`} title={`Remove ${p.label}`}
                  onClick={() => api.removeGeo(p.id).catch((err: Error) => onError?.(err.message))}>✕</button>
              </div>
            ))}
            <form className="row end" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); startNewAsset(); }}>
              <Field label="New asset" grow><input id="map-new-asset" placeholder="e.g. Changi" value={newAsset} onChange={(e) => setNewAsset(e.target.value)} /></Field>
              <button type="submit" className="btn sm" disabled={!newAsset.trim()}>Place</button>
            </form>
            <button type="button" className="btn sm" style={{ marginTop: 6 }}
              title="Place the demo assets (Changi and Paya Lebar airbases, Tuas Port, Jurong Island, Sembawang, Marina Bay) and every device not on the map yet"
              onClick={() => api.seedGeo().catch((err: Error) => onError?.(err.message))}>
              Seed Singapore layout
            </button>
            {unplaced.length > 0 && <span className="muted small">{unplaced.length} device{unplaced.length === 1 ? "" : "s"} not on the map yet</span>}
          </div>
        )}
      </div>
      <div className="map-legend" aria-label="Map legend">
        <Pill tone="lh">◆ asset</Pill><Pill tone="ok">● device alive</Pill><Pill tone="warn">◌ device suspect</Pill><Pill tone="bad">⊗ device offline</Pill><Pill tone="threat">— track</Pill>
      </div>
    </div>
  );
}
