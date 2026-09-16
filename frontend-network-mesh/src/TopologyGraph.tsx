import { useEffect, useMemo, useRef, useState } from "react";
import type { MeshState, NodeStatus, RemoteMember, ThreatAssignmentEvent } from "./types";
import { consensus } from "./consensus";
import { defenseTooltip, systemName, systemOf } from "./defense";
import { groupRemotes, remoteDevice } from "./remotes";
import type { RemoteDevice } from "./remotes";

const COLOR: Record<NodeStatus | "unknown", string> = {
  alive: "var(--alive)",
  suspect: "var(--suspect)",
  dead: "var(--dead)",
  unknown: "var(--faint)",
};

const W = 800;
const H = 520;
const MARGIN = 30;
const POS_KEY = "mesh-topology-positions";
const LINKS_KEY = "mesh-topology-routers";
const VIEW_KEY = "mesh-topology-view"; // { collapse, showLinks }
const CLICK_SLOP = 4; // px of pointer travel below which pointerdown→up counts as a click
const COL_W = 118; // width of one remote-device column (expanded view)

interface XY {
  x: number;
  y: number;
}

type Link = [string, string];

interface ViewOptions {
  collapse: boolean; // one card per remote device instead of one glyph per node
  showLinks: boolean; // draw the gossip web
}

/**
 * Physical-topology overlay: the defense layers hand off through commercial
 * routers. Routers are pure visualization — they exist only in this file,
 * never in the mesh, the API, or gossip. This is the default set; the user
 * can add (link two glyphs) and remove (click a router) at runtime.
 */
const DEFAULT_LINKS: Link[] = [
  ["maelstrom", "aegis"],
  ["aegis", "smartfalcon"],
  ["smartfalcon", "edgefuse"],
  ["edgefuse", "wisl"],
];
const routerId = (a: string, b: string) => `rtr:${a}:${b}`;
const linkKey = ([a, b]: Link) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const xlhId = (addr: string) => `xlh:${addr}`;
const devId = (device: string) => `dev:${device}`;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    // Plain-object settings merge over their defaults (new keys get a default);
    // arrays and everything else are taken as stored.
    const plain = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    return plain(fallback) && plain(parsed) ? { ...fallback, ...parsed } : parsed;
  } catch {
    return fallback;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Worst-of consensus for a whole device: suspect if any member is suspect,
 *  dead only if every member is dead, alive if every member is alive. */
function deviceBelief(d: RemoteDevice): NodeStatus | "unknown" {
  const statuses = d.members.map((m) => m.status);
  if (statuses.every((s) => s === "dead")) return "dead";
  if (statuses.some((s) => s === "suspect")) return "suspect";
  if (statuses.some((s) => s === "alive")) return "alive";
  return "unknown";
}

/**
 * Live topology. Node color = mesh consensus about that node; a dashed red
 * ring means the process is actually down (ground truth) — watch the ring
 * appear instantly on a kill while the fill takes seconds to catch up: that
 * lag is SWIM's suspect→dead detection window happening in real time.
 *
 * Members on other machines are drawn on the right: one card per device
 * (default) or, expanded, one glyph per node in a column per device.
 *
 * Every glyph is draggable; dragged positions, the router set and the view
 * options persist in localStorage. Undragged glyphs keep their computed
 * default (routers: the live midpoint of their endpoints).
 */
export function TopologyGraph({
  state,
  activeThreat,
}: {
  state: MeshState;
  activeThreat?: ThreatAssignmentEvent | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [pos, setPos] = useState<Record<string, XY>>(() => loadJson(POS_KEY, {}));
  const [links, setLinks] = useState<Link[]>(() => loadJson(LINKS_KEY, DEFAULT_LINKS));
  const [view, setView] = useState<ViewOptions>(() => loadJson(VIEW_KEY, { collapse: true, showLinks: true }));
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const drag = useRef<{ name: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);

  useEffect(() => {
    // Debounced: dragging fires setPos per pointermove — persist only once the
    // position has been stable for a beat, not on every frame.
    const t = setTimeout(() => localStorage.setItem(POS_KEY, JSON.stringify(pos)), 300);
    return () => clearTimeout(t);
  }, [pos]);
  useEffect(() => {
    localStorage.setItem(LINKS_KEY, JSON.stringify(links));
  }, [links]);
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  }, [view]);

  useEffect(() => {
    if (!linkMode) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelLinking();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linkMode]);

  const cancelLinking = () => {
    setLinkMode(false);
    setLinkFrom(null);
  };

  const resetLayout = () => {
    setPos({});
    setLinks(DEFAULT_LINKS);
    cancelLinking();
  };

  // Everything derived from the mesh state — glyph lists, default layout, the
  // gossip web and each node's consensus belief — is memoised on the slices it
  // reads. Drags (setPos) and threat highlights then only touch positions.
  const derived = useMemo(() => {
    const lighthouses = state.procs.filter((p) => p.kind === "lighthouse");
    const nodes = state.procs.filter((p) => p.kind === "node");
    // Members on other machines (learned via gossip) and the external lighthouses
    // they were reached through. Drawn as first-class glyphs, but read-only.
    const remotes = state.remotes;
    const remoteDevices = groupRemotes(remotes);
    const extraLh = state.extraLighthouses;
    const remoteIds = new Set(remotes.map((r) => r.id));
    const deviceOfRemote = new Map<string, string>(); // remote node id → device id
    for (const d of remoteDevices) for (const m of d.members) deviceOfRemote.set(m.id, devId(d.device));
    // In collapsed view a remote node is represented by its device card.
    const glyphFor = (id: string) => (view.collapse ? deviceOfRemote.get(id) ?? id : id);

    // ---------- default positions ----------
    const defaults = new Map<string, XY>();
    const lhSlots = lighthouses.length + extraLh.length;
    lighthouses.forEach((p, i) =>
      defaults.set(p.name, { x: ((i + 1) * W) / (lhSlots + 1), y: 52 })
    );
    extraLh.forEach((addr, j) =>
      defaults.set(xlhId(addr), { x: ((lighthouses.length + j + 1) * W) / (lhSlots + 1), y: 52 })
    );
    // Local nodes on a circle, shifted left to make room for the remote devices.
    const shift = remoteDevices.length ? (view.collapse ? 60 : Math.min(2, remoteDevices.length) * 62) : 0;
    const cx = W / 2 - shift, cy = 310, r = Math.min(185, 60 + nodes.length * 22);
    nodes.forEach((p, i) => {
      const a = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      defaults.set(p.name, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    });
    const colX = (k: number) => W - 62 - (remoteDevices.length - 1 - k) * COL_W;
    remoteDevices.forEach((d, k) => {
      // Collapsed: cards stacked down the right edge. Expanded: one column per device.
      const span = H - 210;
      defaults.set(devId(d.device), { x: W - 75, y: 120 + ((k + 0.5) * span) / remoteDevices.length });
      d.members.forEach((m, j) => {
        defaults.set(m.id, { x: colX(k), y: 140 + ((j + 0.5) * span) / d.members.length });
      });
    });

    // ---------- router endpoints ----------
    const glyphNames = new Set([
      ...state.procs.map((p) => p.name),
      ...(view.collapse ? remoteDevices.map((d) => devId(d.device)) : remotes.map((m) => m.id)),
    ]);
    // Default router links name services ("aegis"); a fleet joined to other
    // machines runs as "aegis-<device>", so resolve link endpoints by service too.
    const byService = new Map<string, string>();
    for (const p of nodes) if (p.service && !byService.has(p.service)) byService.set(p.service, p.name);

    // ---------- gossip web ----------
    // An edge from each reachable observer to every peer it believes alive,
    // deduped by unordered pair so A↔B is drawn once. In collapsed view every
    // edge to a remote node lands on its device card (and is deduped there too).
    const nodeNames = new Set(nodes.map((p) => p.name));
    const edgeMap = new Map<string, { from: string; to: string; wan: boolean }>();
    if (view.showLinks) {
      for (const v of state.views) {
        if (!v.reachable || !nodeNames.has(v.id)) continue;
        for (const [peer, entry] of Object.entries(v.view)) {
          if (entry.status !== "alive" || (!nodeNames.has(peer) && !remoteIds.has(peer))) continue;
          const to = glyphFor(peer);
          const key = v.id < to ? `${v.id} ${to}` : `${to} ${v.id}`;
          if (!edgeMap.has(key)) edgeMap.set(key, { from: v.id, to, wan: remoteIds.has(peer) });
        }
      }
    }
    const edges = [...edgeMap.values()];

    // ---------- beliefs ----------
    // Colour is mesh consensus for local and remote nodes alike (consensus()
    // walks the local views, which hold remote entries too).
    const beliefs = new Map<string, NodeStatus | "unknown">();
    for (const p of nodes) beliefs.set(p.name, consensus(state, p.name));
    for (const m of remotes) beliefs.set(m.id, consensus(state, m.id));

    return { lighthouses, nodes, remotes, remoteDevices, extraLh, glyphFor, defaults, cx, cy, colX, glyphNames, byService, edges, beliefs };
    // consensus() reads state.views only; the other reads are the slices listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.procs, state.remotes, state.extraLighthouses, state.views, view.collapse, view.showLinks]);
  const { lighthouses, nodes, remotes, remoteDevices, extraLh, glyphFor, defaults, cx, cy, colX, glyphNames, byService, edges, beliefs } = derived;

  const getPos = (name: string): XY => pos[name] ?? defaults.get(name) ?? { x: cx, y: cy };

  // ---------- routers (visual overlay) ----------
  const resolveEnd = (n: string) => (glyphNames.has(n) ? n : byService.get(n) ?? (glyphNames.has(glyphFor(n)) ? glyphFor(n) : undefined));
  const routers = links
    .map(([a, b]) => [resolveEnd(a), resolveEnd(b)] as [string | undefined, string | undefined])
    .filter((l): l is Link => !!l[0] && !!l[1] && l[0] !== l[1])
    .map(([a, b]) => {
      const id = routerId(a, b);
      const pa = getPos(a), pb = getPos(b);
      return { id, a, b, at: pos[id] ?? { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } };
    });

  // ---------- add / remove routers by clicking ----------
  const clickGlyph = (name: string) => {
    if (!linkMode) return;
    if (!linkFrom) return setLinkFrom(name);
    if (linkFrom === name) return setLinkFrom(null); // clicking it again deselects
    const next: Link = [linkFrom, name];
    setLinks((prev) => (prev.some((l) => linkKey(l) === linkKey(next)) ? prev : [...prev, next]));
    cancelLinking();
  };

  const clickRouter = (rt: { id: string; a: string; b: string }) => {
    setLinks((prev) => prev.filter((l) => linkKey(l) !== linkKey([rt.a, rt.b])));
    setPos((prev) => {
      if (!(rt.id in prev)) return prev;
      const { [rt.id]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  // ---------- drag handlers (pointer capture keeps events on the glyph) ----------
  const toSvg = (e: React.PointerEvent): XY => {
    const m = svgRef.current!.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const startDrag = (name: string, current: XY) => (e: React.PointerEvent<SVGGElement>) => {
    const p = toSvg(e);
    drag.current = { name, dx: current.x - p.x, dy: current.y - p.y, sx: p.x, sy: p.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent<SVGGElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toSvg(e);
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < CLICK_SLOP) return;
    d.moved = true;
    setPos((prev) => ({
      ...prev,
      [d.name]: {
        x: clamp(p.x + d.dx, MARGIN, W - MARGIN),
        y: clamp(p.y + d.dy, MARGIN, H - MARGIN),
      },
    }));
  };
  const endDrag = (onClick?: () => void) => () => {
    if (drag.current && !drag.current.moved) onClick?.();
    drag.current = null;
  };
  const dragProps = (name: string, current: XY, onClick?: () => void) => ({
    onPointerDown: startDrag(name, current),
    onPointerMove: moveDrag,
    onPointerUp: endDrag(onClick),
    onPointerCancel: endDrag(),
    style: {
      cursor: linkMode && onClick ? "crosshair" : "grab",
      touchAction: "none",
    } as React.CSSProperties,
  });

  if (!state.procs.length && !remotes.length) {
    return <div className="empty">No processes yet — boot the demo mesh or add servers.</div>;
  }

  // ---------- glyphs ----------
  // One renderer for local and remote nodes; colour is the memoised belief.
  const nodeGlyph = (id: string, service: string | undefined, running: boolean, remote?: RemoteMember) => {
    const at = getPos(id);
    const belief = beliefs.get(id) ?? "unknown";
    const isPrimary = activeThreat?.primary === id;
    const fallbackRank = activeThreat ? activeThreat.fallbacks.indexOf(id) : -1;
    const sys = systemOf(id, service);
    return (
      <g key={id} transform={`translate(${at.x},${at.y})`}
        {...dragProps(id, at, () => clickGlyph(id))}>
        <title>
          {(defenseTooltip(id, service) ?? id) + (remote
            ? `\nREMOTE — on ${remoteDevice(remote)}, reached over the internet at ${remote.host}:${remote.port}\nbelief: ${remote.status} (${remote.observers} local observers)`
            : "")}
        </title>
        {linkFrom === id && (
          <circle r={30} fill="none" stroke="var(--accent, #3E9BFF)" strokeWidth={2} strokeDasharray="3 3" />
        )}
        {isPrimary && (
          <>
            <circle className="threat-ring" r={27} fill="none"
              stroke="var(--suspect)" strokeWidth={2.5} />
            <text y={-33} textAnchor="middle" fill="var(--suspect)" fontSize={11} fontWeight={700}>
              ⚑ {activeThreat!.threat}
            </text>
          </>
        )}
        {fallbackRank >= 0 && (
          <>
            <circle r={25} fill="none" stroke="var(--suspect)" strokeOpacity={0.45}
              strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={20} y={-20} textAnchor="middle" fill="var(--suspect)"
              fillOpacity={0.8} fontSize={10} fontWeight={700}>
              {fallbackRank + 2}
            </text>
          </>
        )}
        {!running && (
          <circle r={26} fill="none" stroke="var(--dead)" strokeWidth={2} strokeDasharray="4 4" />
        )}
        {remote && (
          <circle r={26} fill="none" stroke="var(--accent)" strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="2 4" />
        )}
        <circle r={19} fill={COLOR[belief]} fillOpacity={0.22}
          stroke={COLOR[belief]} strokeWidth={2.5} />
        <text textAnchor="middle" dy={4} fill="var(--text)"
          fontSize={sys ? 9 : id.length > 6 ? 9 : 12} fontWeight={700}>
          {sys?.short ?? id}
        </text>
        <text y={36} textAnchor="middle" fill="var(--muted)" fontSize={11}>
          {sys?.layer ?? service ?? ""}
        </text>
      </g>
    );
  };

  // One card per remote device: name, address, alive count, aggregate belief,
  // and the threat engagement of its best-ranked member rolled up.
  const deviceCard = (d: RemoteDevice) => {
    const id = devId(d.device);
    const at = getPos(id);
    const belief = deviceBelief(d);
    const memberIds = new Set(d.members.map((m) => m.id));
    const primary = activeThreat && memberIds.has(activeThreat.primary ?? "") ? activeThreat.primary! : undefined;
    const ranks = activeThreat ? activeThreat.fallbacks.map((f, i) => (memberIds.has(f) ? i : -1)).filter((i) => i >= 0) : [];
    const fallbackRank = ranks.length ? Math.min(...ranks) : -1;
    const fallbackId = fallbackRank >= 0 ? activeThreat!.fallbacks[fallbackRank] : undefined;
    const CW = 124, CH = 62;
    const services = d.members.map((m) => systemOf(m.id, m.service)?.short ?? m.service ?? m.id);
    return (
      <g key={id} transform={`translate(${at.x},${at.y})`} {...dragProps(id, at, () => clickGlyph(id))}>
        <title>
          {`${d.device} — ${d.members.length} node${d.members.length === 1 ? "" : "s"} at ${d.host}, ${d.alive} alive\n${d.members.map((m) => `${m.id}: ${m.status}`).join("\n")}\n(expand devices to see each node)`}
        </title>
        {linkFrom === id && (
          <rect x={-CW / 2 - 6} y={-CH / 2 - 6} width={CW + 12} height={CH + 12} rx={14}
            fill="none" stroke="var(--accent, #3E9BFF)" strokeWidth={2} strokeDasharray="3 3" />
        )}
        {primary && (
          <>
            <rect className="threat-ring-rect" x={-CW / 2 - 5} y={-CH / 2 - 5} width={CW + 10} height={CH + 10} rx={13}
              fill="none" stroke="var(--suspect)" strokeWidth={2.5} />
            <text y={-CH / 2 - 11} textAnchor="middle" fill="var(--suspect)" fontSize={11} fontWeight={700}>
              ⚑ {activeThreat!.threat} · {systemName(primary)}
            </text>
          </>
        )}
        {!primary && fallbackRank >= 0 && (
          <>
            <rect x={-CW / 2 - 4} y={-CH / 2 - 4} width={CW + 8} height={CH + 8} rx={12}
              fill="none" stroke="var(--suspect)" strokeOpacity={0.45} strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={CW / 2 - 2} y={-CH / 2 - 8} textAnchor="end" fill="var(--suspect)" fillOpacity={0.85} fontSize={10} fontWeight={700}>
              {fallbackRank + 2} · {systemName(fallbackId!)}
            </text>
          </>
        )}
        <rect x={-CW / 2} y={-CH / 2} width={CW} height={CH} rx={10}
          fill={COLOR[belief]} fillOpacity={0.14} stroke={COLOR[belief]} strokeWidth={2} />
        <rect x={-CW / 2} y={-CH / 2} width={CW} height={CH} rx={10}
          fill="none" stroke="var(--accent)" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 4" />
        <text textAnchor="middle" y={-CH / 2 + 17} fill="var(--text)" fontSize={12} fontWeight={700}>
          ⟡ {d.device}
        </text>
        <text textAnchor="middle" y={-CH / 2 + 31} fill="var(--muted)" fontSize={9.5} fontFamily="Consolas, 'Cascadia Mono', monospace">
          {d.host}
        </text>
        <text textAnchor="middle" y={-CH / 2 + 46} fill={COLOR[belief]} fontSize={10.5} fontWeight={700}>
          {d.alive}/{d.members.length} alive
        </text>
        <text textAnchor="middle" y={-CH / 2 + 58} fill="var(--muted)" fontSize={8.5}>
          {services.slice(0, 5).join(" · ")}{services.length > 5 ? " …" : ""}
        </text>
      </g>
    );
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 6, alignItems: "center", gap: 8 }}>
        <button onClick={() => (linkMode ? cancelLinking() : setLinkMode(true))}
          className={linkMode ? "primary" : undefined}>
          {linkMode ? "cancel" : "+ router"}
        </button>
        <button onClick={resetLayout}>reset layout</button>
        <button className={view.collapse ? "toggle on" : "toggle"} title="one card per remote device, or one glyph per remote node"
          onClick={() => setView((v) => ({ ...v, collapse: !v.collapse }))}
          disabled={!remoteDevices.length}>
          {view.collapse ? "⊞ expand devices" : "⊟ collapse devices"}
        </button>
        <button className={view.showLinks ? "toggle on" : "toggle"} title="show or hide the gossip links (who believes whom alive)"
          onClick={() => setView((v) => ({ ...v, showLinks: !v.showLinks }))}>
          {view.showLinks ? "links on" : "links off"}
        </button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          {linkMode
            ? linkFrom
              ? `linking from ${systemOf(linkFrom)?.name ?? linkFrom} — click the other endpoint (esc cancels)`
              : "click the two glyphs to join through a router (esc cancels)"
            : "drag to rearrange · click a router to remove it"}
        </span>
      </div>

      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}>
        {/* Physical links through commercial routers (visual only) */}
        {routers.map((rt) => {
          const pa = getPos(rt.a), pb = getPos(rt.b);
          return (
            <g key={`link-${rt.id}`}>
              <line x1={pa.x} y1={pa.y} x2={rt.at.x} y2={rt.at.y}
                stroke="var(--muted)" strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="6 5" />
              <line x1={rt.at.x} y1={rt.at.y} x2={pb.x} y2={pb.y}
                stroke="var(--muted)" strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="6 5" />
            </g>
          );
        })}

        {edges.map((e, i) => {
          const a = getPos(e.from), b = getPos(e.to);
          return e.wan ? (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="var(--accent)" strokeOpacity={0.3} strokeWidth={1.5} strokeDasharray="3 5" />
          ) : (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="var(--alive)" strokeOpacity={0.12} strokeWidth={1.5} />
          );
        })}

        {/* External lighthouses: join brokers on other machines (EXTRA_LIGHTHOUSES) */}
        {extraLh.map((addr) => {
          const id = xlhId(addr);
          const at = getPos(id);
          return (
            <g key={id} transform={`translate(${at.x},${at.y})`} {...dragProps(id, at)}>
              <title>{`External lighthouse at ${addr}\nEvery local node joins it too — this is how the fleet meets peers on other networks`}</title>
              <rect x={-13} y={-13} width={26} height={26} rx={5}
                transform="rotate(45)" fill="none" stroke="var(--lh)" strokeWidth={2.5} strokeDasharray="4 3" />
              <circle r={4} fill="var(--lh)" />
              <text y={-24} textAnchor="middle" fill="var(--accent)" fontSize={9} fontWeight={700}>⟡ INTERNET</text>
              <text y={32} textAnchor="middle" fill="var(--muted)" fontSize={10}>{addr}</text>
            </g>
          );
        })}

        {routers.map((rt) => (
          <g key={rt.id} transform={`translate(${rt.at.x},${rt.at.y})`}
            {...dragProps(rt.id, rt.at, () => clickRouter(rt))}
            style={{ cursor: "grab", touchAction: "none" }}>
            <title>Commercial router — visualization only · click to remove, drag to move</title>
            <rect x={-13} y={-8} width={26} height={16} rx={3}
              fill="var(--panel, #111B2E)" stroke="var(--muted)" strokeWidth={1.5} />
            <line x1={-6} y1={-8} x2={-9} y2={-15} stroke="var(--muted)" strokeWidth={1.5} />
            <line x1={6} y1={-8} x2={9} y2={-15} stroke="var(--muted)" strokeWidth={1.5} />
            <circle cx={-6} cy={0} r={1.5} fill="var(--muted)" />
            <circle cx={0} cy={0} r={1.5} fill="var(--muted)" />
            <circle cx={6} cy={0} r={1.5} fill="var(--muted)" />
            <text y={22} textAnchor="middle" fill="var(--muted)" fontSize={9}>router</text>
          </g>
        ))}

        {lighthouses.map((p) => {
          const at = getPos(p.name);
          return (
            <g key={p.name} transform={`translate(${at.x},${at.y})`}
              opacity={p.running ? 1 : 0.35} {...dragProps(p.name, at, () => clickGlyph(p.name))}>
              {linkFrom === p.name && (
                <circle r={24} fill="none" stroke="var(--accent, #3E9BFF)" strokeWidth={2} strokeDasharray="3 3" />
              )}
              <rect x={-13} y={-13} width={26} height={26} rx={5}
                transform="rotate(45)" fill="none" stroke="var(--lh)" strokeWidth={2.5} />
              <circle r={4} fill={p.running ? "var(--lh)" : "var(--dead)"} />
              <text y={32} textAnchor="middle" fill="var(--muted)" fontSize={11}>
                {p.name}
              </text>
            </g>
          );
        })}

        {/* Expanded view: device headers over each remote column */}
        {!view.collapse && remoteDevices.map((d, k) => (
          <g key={`dev-${d.device}`} transform={`translate(${colX(k)},100)`}>
            <title>{`${d.device} — ${d.members.length} node${d.members.length === 1 ? "" : "s"} at ${d.host}, ${d.alive} alive`}</title>
            <rect x={-COL_W / 2 + 6} y={-14} width={COL_W - 12} height={H - 150} rx={10}
              fill="var(--accent)" fillOpacity={0.04} stroke="var(--accent)" strokeOpacity={0.25} strokeDasharray="4 4" />
            <text textAnchor="middle" dy={2} fill="var(--accent)" fontSize={11} fontWeight={700}>⟡ {d.device}</text>
            <text textAnchor="middle" y={14} fill="var(--muted)" fontSize={9.5}>{d.host}</text>
          </g>
        ))}

        {nodes.map((p) => nodeGlyph(p.name, p.service, p.running))}
        {view.collapse
          ? remoteDevices.map((d) => deviceCard(d))
          : remotes.map((m) => nodeGlyph(m.id, m.service, true, m))}

        <g transform={`translate(14,${H - 14})`} fontSize={11} fill="var(--muted)">
          <circle cx={4} r={5} fill="var(--alive)" fillOpacity={0.4} stroke="var(--alive)" />
          <text x={14} dy={4}>alive (belief)</text>
          <circle cx={110} r={5} fill="var(--suspect)" fillOpacity={0.4} stroke="var(--suspect)" />
          <text x={120} dy={4}>suspect</text>
          <circle cx={190} r={5} fill="var(--dead)" fillOpacity={0.4} stroke="var(--dead)" />
          <text x={200} dy={4}>dead</text>
          <circle cx={255} r={7} fill="none" stroke="var(--dead)" strokeDasharray="3 3" />
          <text x={268} dy={4}>process actually down</text>
          <line x1={410} y1={0} x2={432} y2={0} stroke="var(--muted)" strokeOpacity={0.5}
            strokeWidth={1.5} strokeDasharray="6 5" />
          <text x={438} dy={4}>via commercial router</text>
          <circle cx={575} r={7} fill="none" stroke="var(--suspect)" strokeWidth={2} />
          <text x={588} dy={4}>engaging threat</text>
          {(remotes.length > 0 || extraLh.length > 0) && (
            <>
              <rect x={688} y={-6} width={14} height={12} rx={3} fill="none" stroke="var(--accent)" strokeDasharray="2 3" />
              <text x={707} dy={4}>other device</text>
            </>
          )}
        </g>
      </svg>
    </>
  );
}
