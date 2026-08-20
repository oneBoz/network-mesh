import { useState, useRef, useEffect, useCallback, CSSProperties } from "react";

// ---------- types ----------
type NodeStatus = "alive" | "suspect" | "dead";
type LogKind = "info" | "alive" | "dead";

interface ViewEntry {
  status: NodeStatus;
  inc: number;
  t: number; // ticks spent in current status (for suspect aging)
}

interface SimNode {
  id: number;
  name: string;
  site: number;
  x: number;
  y: number;
  up: boolean;
  lighthouse: boolean;
  svc: string | null;
  inc: number;
  view: Record<number, ViewEntry>;
  deadAnnounced: boolean;
}

interface GossipMsg {
  from: number;
  to: number;
  ok: boolean;
}

interface LogEntry {
  t: number;
  msg: string;
  kind: LogKind;
}

interface Sim {
  nodes: SimNode[];
  tick: number;
  partitioned: Set<number>;
  msgs: GossipMsg[];
  log: LogEntry[];
}

interface Site {
  id: string;
  cx: number;
  cy: number;
}

// ---------- palette ----------
const C = {
  bg: "#0B1220", panel: "#111B2E", panelEdge: "#1E2A44",
  text: "#E6EDF3", muted: "#7D8CA6", faint: "#3A4A68",
  alive: "#2DD4A7", suspect: "#F5B841", dead: "#E5484D",
  lh: "#8B7CF6", pulse: "#3E9BFF",
} as const;

// Defense systems the mesh's server sites run: MAELSTROM Command (Layer 1),
// AEGIS (Layer 2), SmartFalcon (Layer 3), EdgeFuse (Layer 4), WISL (EMP defense).
const SERVICES = ["maelstrom", "aegis", "smartfalcon", "edgefuse", "wisl"] as const;
const SITES: Site[] = [
  { id: "A", cx: 195, cy: 175 },
  { id: "B", cx: 525, cy: 175 },
  { id: "C", cx: 360, cy: 430 },
];
const SUSPECT_TICKS = 5;
const RANK: Record<NodeStatus, number> = { alive: 0, suspect: 1, dead: 2 };

let nextId = 0;

function makeNode(siteIdx: number, indexInSite: number, lighthouse: boolean): SimNode {
  const s = SITES[siteIdx];
  const r = lighthouse ? 0 : 66;
  const ang = (indexInSite * (Math.PI * 2)) / 8 - Math.PI / 2;
  const id = nextId++;
  return {
    id,
    name: `${s.id}${indexInSite + 1}`,
    site: siteIdx,
    x: s.cx + r * Math.cos(ang),
    y: s.cy + r * Math.sin(ang),
    up: true,
    lighthouse,
    svc: lighthouse ? null : SERVICES[id % SERVICES.length],
    inc: 0,
    view: {},
    deadAnnounced: false,
  };
}

function initSim(): Sim {
  nextId = 0;
  const nodes: SimNode[] = [];
  for (let s = 0; s < 3; s++)
    for (let k = 0; k < 3; k++) nodes.push(makeNode(s, k, k === 0));
  for (const a of nodes) {
    a.view = {};
    for (const b of nodes)
      if (b.id !== a.id) a.view[b.id] = { status: "alive", inc: 0, t: 0 };
  }
  return {
    nodes, tick: 0, partitioned: new Set<number>(), msgs: [],
    log: [{ t: 0, msg: "Mesh bootstrapped: 9 servers, 3 sites, 3 lighthouses", kind: "info" }],
  };
}

function canTalk(a: SimNode, b: SimNode, part: Set<number>): boolean {
  if (a.site === b.site) return true;
  return !part.has(a.site) && !part.has(b.site);
}

function mergeRumor(view: Record<number, ViewEntry>, id: number, status: NodeStatus, inc: number): boolean {
  const cur = view[id];
  if (!cur || inc > cur.inc || (inc === cur.inc && RANK[status] > RANK[cur.status])) {
    view[id] = { status, inc, t: 0 };
    return true;
  }
  return false;
}

function pushLog(sim: Sim, msg: string, kind: LogKind): void {
  sim.log = [{ t: sim.tick, msg, kind }, ...sim.log].slice(0, 30);
}

function stepSim(sim: Sim): void {
  sim.tick++;
  sim.msgs = [];
  const byId: Record<number, SimNode> = Object.fromEntries(sim.nodes.map((n) => [n.id, n]));

  for (const a of sim.nodes) {
    if (!a.up) continue;
    for (const e of Object.values(a.view)) {
      if (e.status === "suspect" && ++e.t > SUSPECT_TICKS) {
        e.status = "dead";
        e.t = 0;
      }
    }
    const cands = Object.keys(a.view)
      .map(Number)
      .filter((id) => a.view[id].status !== "dead" && byId[id]);
    if (!cands.length) continue;
    const b = byId[cands[Math.floor(Math.random() * cands.length)]];
    const ok = b.up && canTalk(a, b, sim.partitioned);
    sim.msgs.push({ from: a.id, to: b.id, ok });
    if (ok) {
      const belief = a.view[b.id];
      if (belief && belief.status !== "alive" && belief.inc >= b.inc) b.inc = belief.inc + 1;
      a.view[b.id] = { status: "alive", inc: b.inc, t: 0 };
      b.view[a.id] = { status: "alive", inc: a.inc, t: 0 };
      for (const [id, e] of Object.entries(a.view))
        if (+id !== b.id) mergeRumor(b.view, +id, e.status, e.inc);
      for (const [id, e] of Object.entries(b.view))
        if (+id !== a.id) mergeRumor(a.view, +id, e.status, e.inc);
    } else {
      const e = a.view[b.id];
      if (e && e.status === "alive") a.view[b.id] = { status: "suspect", inc: e.inc, t: 0 };
    }
  }

  const alive = sim.nodes.filter((n) => n.up);
  for (const n of sim.nodes) {
    const believers = alive.filter(
      (a) => a.id !== n.id && a.view[n.id]?.status === "dead"
    ).length;
    const quorum = believers > alive.length / 2 && alive.length > 1;
    if (!n.up && quorum && !n.deadAnnounced) {
      n.deadAnnounced = true;
      pushLog(sim, `${n.name} declared dead by cluster majority — removed from DNS`, "dead");
    }
    if (n.up && n.deadAnnounced) {
      const alivers = alive.filter((a) => a.id !== n.id && a.view[n.id]?.status === "alive").length;
      if (alivers > alive.length / 2) {
        n.deadAnnounced = false;
        pushLog(sim, `${n.name} rejoined — visible in DNS again`, "alive");
      }
    }
  }
}

function convergence(sim: Sim): number {
  const alive = sim.nodes.filter((n) => n.up);
  let ok = 0, total = 0;
  for (const a of alive)
    for (const n of sim.nodes) {
      if (n.id === a.id) continue;
      const bel = a.view[n.id]?.status;
      if (!bel) continue; // no opinion yet — a non-belief can't agree or disagree
      total++;
      if ((n.up && bel === "alive") || (!n.up && bel !== "alive")) ok++;
    }
  return total ? Math.round((100 * ok) / total) : 100;
}

// ---------- component ----------
export default function MeshSimulator(): JSX.Element {
  const simRef = useRef<Sim>(initSim());
  const [, force] = useState(0);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(550);
  const [sel, setSel] = useState<number | null>(null);
  const rerender = useCallback(() => force((v) => v + 1), []);

  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => {
      stepSim(simRef.current);
      rerender();
    }, speed);
    return () => clearInterval(iv);
  }, [running, speed, rerender]);

  const sim = simRef.current;
  const byId: Record<number, SimNode> = Object.fromEntries(sim.nodes.map((n) => [n.id, n]));
  const selNode = sel != null ? byId[sel] : null;

  const act = (fn: (s: Sim) => void): void => {
    fn(sim);
    rerender();
  };

  const toggleKill = (): void => {
    if (!selNode) return;
    act((s) => {
      selNode.up = !selNode.up;
      if (selNode.up) {
        selNode.inc++;
        pushLog(s, `${selNode.name} powered on (incarnation ${selNode.inc}) — refuting stale rumors`, "alive");
      } else {
        pushLog(s, `${selNode.name} powered off — peers will suspect, then declare dead`, "dead");
      }
    });
  };

  const addNode = (): void =>
    act((s) => {
      const counts = [0, 0, 0];
      s.nodes.forEach((n) => counts[n.site]++);
      const site = counts.indexOf(Math.min(...counts));
      const nn = makeNode(site, counts[site], false);
      const lh = s.nodes.find((n) => n.lighthouse && n.up && canTalk(nn, n, s.partitioned));
      if (!lh) {
        pushLog(s, `Join failed: no lighthouse reachable from site ${SITES[site].id}`, "dead");
        return;
      }
      nn.view = {};
      for (const [id, e] of Object.entries(lh.view)) nn.view[+id] = { ...e, t: 0 };
      nn.view[lh.id] = { status: "alive", inc: lh.inc, t: 0 };
      lh.view[nn.id] = { status: "alive", inc: 0, t: 0 };
      s.nodes.push(nn);
      pushLog(s, `${nn.name} joined via lighthouse ${lh.name} — no other node touched`, "alive");
    });

  const togglePartition = (siteIdx: number): void =>
    act((s) => {
      if (s.partitioned.has(siteIdx)) {
        s.partitioned.delete(siteIdx);
        pushLog(s, `Site ${SITES[siteIdx].id} uplink restored — tunnels re-establish`, "alive");
      } else {
        s.partitioned.add(siteIdx);
        pushLog(s, `Site ${SITES[siteIdx].id} uplink cut — isolated from other sites`, "dead");
      }
    });

  const reset = (): void => {
    simRef.current = initSim();
    setSel(null);
    rerender();
  };

  const conv = convergence(sim);
  const aliveCount = sim.nodes.filter((n) => n.up).length;

  const beliefColor = (st: NodeStatus | "unknown"): string =>
    st === "alive" ? C.alive : st === "suspect" ? C.suspect : C.dead;

  const dnsView = SERVICES.map((svc) => {
    const inst = sim.nodes.filter((n) => n.svc === svc);
    const healthy = inst.filter((n) =>
      selNode ? selNode.id === n.id || selNode.view[n.id]?.status === "alive" : n.up
    );
    return { svc, healthy, total: inst.length };
  });

  const btn = (extra: CSSProperties = {}): CSSProperties => ({
    background: "transparent", color: C.text, border: `1px solid ${C.panelEdge}`,
    borderRadius: 8, padding: "7px 12px", fontSize: 12.5, cursor: "pointer",
    fontFamily: "inherit", ...extra,
  });

  return (
    <div
      style={{
        minHeight: "100vh", background: C.bg, color: C.text, padding: 20,
        fontFamily: "'SF Mono','Cascadia Code','JetBrains Mono',Menlo,Consolas,monospace",
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 19, fontWeight: 600, margin: 0, letterSpacing: 0.3 }}>
            mesh<span style={{ color: C.alive }}>-sim</span>
          </h1>
          <span style={{ fontSize: 12, color: C.muted }}>
            SWIM gossip · lighthouses · service discovery — click a server, then break things
          </span>
        </div>

        <div style={{ display: "flex", gap: 22, margin: "14px 0", fontSize: 12.5, flexWrap: "wrap" }}>
          <span>tick <b style={{ color: C.pulse }}>{sim.tick}</b></span>
          <span>servers up <b style={{ color: C.alive }}>{aliveCount}</b>/{sim.nodes.length}</span>
          <span>
            cluster agreement{" "}
            <b style={{ color: conv > 95 ? C.alive : conv > 75 ? C.suspect : C.dead }}>{conv}%</b>
          </span>
          <span style={{ color: C.muted }}>
            agreement = how many peer beliefs match reality; watch it dip on failure, then self-heal to 100%
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
          <button style={btn()} onClick={() => setRunning(!running)}>
            {running ? "⏸ pause" : "▶ run"}
          </button>
          <button style={btn()} onClick={addNode}>+ add server</button>
          <button
            style={btn(
              selNode
                ? { borderColor: selNode.up ? C.dead : C.alive, color: selNode.up ? C.dead : C.alive }
                : { opacity: 0.4, cursor: "default" }
            )}
            onClick={toggleKill}
            disabled={!selNode}
          >
            {selNode ? (selNode.up ? `⏻ kill ${selNode.name}` : `⏻ revive ${selNode.name}`) : "⏻ kill (select a server)"}
          </button>
          {SITES.map((s, i) => (
            <button
              key={s.id}
              style={btn(sim.partitioned.has(i) ? { borderColor: C.dead, color: C.dead } : {})}
              onClick={() => togglePartition(i)}
            >
              {sim.partitioned.has(i) ? `restore site ${s.id}` : `✂ cut site ${s.id}`}
            </button>
          ))}
          <button style={btn()} onClick={reset}>↺ reset</button>
          <label
            style={{ fontSize: 12, color: C.muted, display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}
          >
            gossip interval
            <input
              type="range" min={200} max={1200} step={50} value={speed}
              onChange={(e) => setSpeed(+e.target.value)}
              style={{ accentColor: C.alive }}
            />
            {speed}ms
          </label>
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 560px", background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: 6 }}>
            <svg viewBox="0 0 720 560" style={{ width: "100%", display: "block" }}>
              {SITES.map((s, i) => (
                <g key={s.id}>
                  <circle
                    cx={s.cx} cy={s.cy} r={102}
                    fill={sim.partitioned.has(i) ? "rgba(229,72,77,0.06)" : "rgba(62,155,255,0.04)"}
                    stroke={sim.partitioned.has(i) ? C.dead : C.faint}
                    strokeDasharray="5 5" strokeWidth={1}
                  />
                  <text
                    x={s.cx} y={s.cy - 114} textAnchor="middle" fontSize={12}
                    fill={sim.partitioned.has(i) ? C.dead : C.muted}
                  >
                    site {s.id}{sim.partitioned.has(i) ? " · uplink cut" : ""}
                  </text>
                </g>
              ))}
              {sim.msgs.map((m, i) => {
                const a = byId[m.from], b = byId[m.to];
                if (!a || !b) return null;
                return (
                  <line
                    key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={m.ok ? C.pulse : C.dead} strokeWidth={m.ok ? 1.2 : 1}
                    strokeDasharray={m.ok ? "none" : "3 4"} opacity={m.ok ? 0.55 : 0.7}
                  />
                );
              })}
              {sim.nodes.map((n) => {
                const belief: NodeStatus | null =
                  selNode && selNode.id !== n.id ? selNode.view[n.id]?.status ?? "dead" : null;
                return (
                  <g key={n.id} onClick={() => setSel(n.id === sel ? null : n.id)} style={{ cursor: "pointer" }}>
                    {belief && (
                      <circle cx={n.x} cy={n.y} r={19} fill="none" stroke={beliefColor(belief)} strokeWidth={2.5} opacity={0.9} />
                    )}
                    <circle
                      cx={n.x} cy={n.y} r={13}
                      fill={n.up ? (n.lighthouse ? C.lh : C.alive) : "#3A1D26"}
                      stroke={sel === n.id ? C.text : n.up ? "transparent" : C.dead}
                      strokeWidth={sel === n.id ? 2 : 1.2}
                      opacity={n.up ? 1 : 0.85}
                    />
                    <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={n.up ? "#06251C" : C.dead}>
                      {n.name}
                    </text>
                    <text x={n.x} y={n.y + 28} textAnchor="middle" fontSize={9.5} fill={C.muted}>
                      {n.lighthouse ? "lighthouse" : n.svc}
                    </text>
                  </g>
                );
              })}
              <g fontSize={10.5} fill={C.muted}>
                <circle cx={22} cy={532} r={6} fill={C.alive} />
                <text x={34} y={536}>server up</text>
                <circle cx={116} cy={532} r={6} fill={C.lh} />
                <text x={128} y={536}>lighthouse</text>
                <circle cx={218} cy={532} r={6} fill="#3A1D26" stroke={C.dead} />
                <text x={230} y={536}>down</text>
                <line x1={286} y1={532} x2={314} y2={532} stroke={C.pulse} />
                <text x={322} y={536}>gossip ok</text>
                <line x1={408} y1={532} x2={436} y2={532} stroke={C.dead} strokeDasharray="3 4" />
                <text x={444} y={536}>probe failed</text>
                {selNode && <text x={548} y={536} fill={C.suspect}>rings = {selNode.name}'s beliefs</text>}
              </g>
            </svg>
          </div>

          <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 14, minWidth: 280 }}>
            <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
                {selNode
                  ? `dns as answered by ${selNode.name}'s consul agent`
                  : "dns — ground truth (select a server for its local view)"}
              </div>
              {dnsView.map(({ svc, healthy, total }) => (
                <div
                  key={svc}
                  style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "5px 0", borderBottom: `1px solid ${C.panelEdge}` }}
                >
                  <span style={{ color: C.pulse }}>{svc}.service.consul</span>
                  <span style={{ color: healthy.length ? C.alive : C.dead }}>
                    {healthy.length ? healthy.map((h) => h.name).join(", ") : "NXDOMAIN"}
                    <span style={{ color: C.muted }}> ({healthy.length}/{total})</span>
                  </span>
                </div>
              ))}
              {selNode && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: C.muted, lineHeight: 1.6 }}>
                  {selNode.name}'s membership view:{" "}
                  {sim.nodes
                    .filter((n) => n.id !== selNode.id)
                    .map((n) => {
                      const st: NodeStatus | "unknown" = selNode.view[n.id]?.status ?? "unknown";
                      return (
                        <span key={n.id} style={{ marginRight: 8, whiteSpace: "nowrap" }}>
                          <span style={{ color: beliefColor(st) }}>●</span> {n.name}
                        </span>
                      );
                    })}
                </div>
              )}
            </div>

            <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 12, padding: 14, flex: 1, maxHeight: 330, overflowY: "auto" }}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>event log</div>
              {sim.log.map((l, i) => (
                <div key={i} style={{ fontSize: 11.5, lineHeight: 1.55, marginBottom: 4 }}>
                  <span style={{ color: C.faint }}>t{String(l.t).padStart(3, "0")}</span>{" "}
                  <span style={{ color: l.kind === "dead" ? C.dead : l.kind === "alive" ? C.alive : C.muted }}>
                    {l.msg}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
          Under the hood, this runs real SWIM semantics: each tick every live server probes one random peer; a failed
          probe marks it <span style={{ color: C.suspect }}>suspect</span>; unrefuted suspicion becomes{" "}
          <span style={{ color: C.dead }}>dead</span> after {SUSPECT_TICKS} ticks; revived servers bump their
          incarnation number to refute stale rumors; and every successful probe piggybacks a full rumor exchange.
          Lighthouses matter only at join time — kill all three and existing traffic keeps flowing, but "+ add server" fails.
        </div>
      </div>
    </div>
  );
}
