#!/usr/bin/env node
/**
 * scenario.mjs — run a scripted attack against a running dashboard and watch
 * the engagement lifecycle from the terminal.
 *
 *   node scripts/scenario.mjs [scenario-id] [--url http://127.0.0.1:7070] [--target <geo id>] [--list]
 *
 * Boots the demo fleet if no node is running, seeds the Singapore layout if
 * the map is empty, runs the scenario (default: two-swarms-se) and prints every
 * lifecycle transition — state, responsible node and device, escalations,
 * agreement across the local nodes — until every launched track has ended.
 * Exit 0 when every track ended (neutralised / impact / lost) and all local
 * nodes agree on how; 1 otherwise. Tracks end in IMPACT unless someone
 * neutralises them from a GCS while this runs — that is the point.
 */
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = opt("--url", process.env.MESH_URL ?? "http://127.0.0.1:7070");
const TARGET = opt("--target");
const SCENARIO = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--"))) ?? "two-swarms-se";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, init) {
  const r = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(5_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${r.status} ${body.error ?? JSON.stringify(body)}`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
function fail(msg) { console.error(`\nFAIL: ${msg}`); process.exit(1); }
const secs = (ms) => `${(ms / 1000).toFixed(0)}s`;

let state = await api("/api/state").catch((e) => fail(`dashboard not reachable at ${BASE} (${e.message})`));
const { scenarios } = await api("/api/sim/scenarios");
if (args.includes("--list")) {
  for (const s of scenarios) console.log(`${s.id.padEnd(16)} ${s.name}\n${"".padEnd(17)}${s.description}\n${"".padEnd(17)}${s.steps.map((x) => `+${secs(x.delayMs)} ${x.threat} from ${x.bearing}° ${x.rangeKm} km, ${secs(x.etaMs)} to impact`).join("; ")}`);
  process.exit(0);
}
const sc = scenarios.find((s) => s.id === SCENARIO) ?? fail(`no scenario "${SCENARIO}" — try --list`);

if (!state.procs.some((p) => p.kind === "node" && p.running)) {
  console.log("no node running — booting the demo fleet…");
  await post("/api/demo");
  for (let i = 0; i < 30; i++) {
    await sleep(1_000);
    state = await api("/api/state");
    const nodes = state.procs.filter((p) => p.kind === "node");
    if (nodes.length >= 5 && state.views.filter((v) => v.reachable).length >= nodes.length) break;
  }
}
if (!Object.keys(state.geo.entries).length) {
  const t = await post("/api/geo/seed");
  console.log(`map was empty — seeded ${t.added} entries: ${Object.values(t.entries).map((e) => e.label ?? "device").join(", ")}`);
  state = await api("/api/state");
}

const run = await post(`/api/sim/scenarios/${encodeURIComponent(sc.id)}`, { target: TARGET, station: "scenario.mjs" });
const targetLabel = state.geo.entries[run.target]?.label ?? run.target;
console.log(`device ${state.device}: "${sc.name}" → ${targetLabel}, ${run.launches} launch${run.launches === 1 ? "" : "es"}`);
console.log(sc.steps.map((x) => `  +${secs(x.delayMs).padStart(4)}  ${x.threat.padEnd(8)} from ${String(x.bearing).padStart(3)}° ${String(x.rangeKm).padStart(3)} km, ${secs(x.etaMs)} to impact`).join("\n"));
console.log();

// Follow the tracks this run created (the simulator tags each with the scenario name in its note).
const t0 = run.startedAt;
const deadline = t0 + Math.max(...sc.steps.map((x) => x.delayMs + x.etaMs)) + 30_000;
const last = new Map(); // trackId → last printed signature
const seenIds = new Set();
const isTerminal = (t) => t.state === "neutralised" || t.state === "impact" || t.state === "lost";
let tracks = [];
while (Date.now() < deadline) {
  state = await api("/api/state");
  tracks = state.tracks.filter((t) => t.detectedAt >= t0 - 2_000 && (t.note ?? "").startsWith(sc.name) && t.origin.device === state.device);
  for (const t of tracks) {
    seenIds.add(t.trackId);
    const esc = t.escalations.map((e) => `${e.reason}${e.from ? ` ${e.from}` : ""}→${e.to ?? "nobody"}`).join(", ");
    const sig = `${t.state}|${t.responsibleNode}|${t.escalations.length}|${t.rejected.length}|${t.agree}/${t.seenBy.length}`;
    if (last.get(t.trackId) === sig) continue;
    last.set(t.trackId, sig);
    const head = t.positions.at(-1);
    console.log(`[+${secs(Date.now() - t0).padStart(4)}] ${t.threat.toUpperCase().padEnd(8)} ${t.trackId.slice(0, 12).padEnd(12)} ${t.state.padEnd(11)} responsible ${(t.responsibleNode ?? "NOBODY").padEnd(22)} on ${(t.responsibleDevice ?? "?").padEnd(12)} ${t.agree}/${t.seenBy.length} agree${esc ? `  [${esc}]` : ""}${t.rejected.length ? `  ${t.rejected.length} rejected` : ""}${head?.eta !== undefined && !isTerminal(t) ? `  ETA ${secs(head.eta)}` : ""}`);
  }
  if (seenIds.size >= run.launches && tracks.length >= run.launches && tracks.every(isTerminal)) break;
  await sleep(1_000);
}

console.log();
if (tracks.length < run.launches) fail(`only ${tracks.length} of ${run.launches} launches became tracks`);
if (!tracks.every(isTerminal)) fail(`tracks still live at the deadline: ${tracks.filter((t) => !isTerminal(t)).map((t) => t.trackId).join(", ")}`);
const disagree = tracks.filter((t) => !t.consistent);
for (const t of tracks) console.log(`${t.threat.padEnd(8)} ${t.trackId.slice(0, 12).padEnd(12)} ${t.state.toUpperCase().padEnd(11)} ${t.positions.length} positions, ${t.escalations.length} escalation${t.escalations.length === 1 ? "" : "s"}, ${t.neutralised ? `neutralised by ${t.neutralised.station ?? t.neutralised.node} on ${t.neutralised.device}` : t.state === "impact" ? `hit ${targetLabel}` : "lost"}`);
if (disagree.length) fail(`local nodes disagree on ${disagree.map((t) => t.trackId).join(", ")}`);
console.log(`\nPASS — ${tracks.length} track${tracks.length === 1 ? "" : "s"} ended, every local node agrees`);
