#!/usr/bin/env node
/**
 * preflight.mjs — judging-day go / no-go check against this device's dashboard.
 *
 *   node scripts/preflight.mjs [--url http://127.0.0.1:7070] [--expect azure-vm,mac02] [--drill]
 *
 * Checks, in order: dashboard up · encryption on · local fleet converged and
 * stable · every expected remote device fully alive (and how it is reached) ·
 * map has defended assets · OpenStreetMap tiles reachable (else the bundled
 * basemap will draw) · a cross-device signal reaches 5/5 agreement, timed.
 * With --drill it also rehearses the runbook's self-healing step — kill this
 * device's aegis, time suspect → dead on every node, revive, time the
 * refutation — and puts the fleet back as it was.
 *
 * Prints one line per check with GO / WARN / NO-GO and exits 1 on any NO-GO.
 */
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--url", process.env.MESH_URL ?? "http://127.0.0.1:7070");
const EXPECT = (opt("--expect", process.env.EXPECT_DEVICES ?? "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const DRILL = args.includes("--drill");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init) => { const r = await fetch(BASE + p, { ...init, signal: AbortSignal.timeout(5_000) }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → ${r.status} ${b.error ?? ""}`); return b; };
const post = (p, body) => api(p, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

let nogo = 0;
const row = (level, what, detail) => { if (level === "NO-GO") nogo++; console.log(`${level.padEnd(6)} ${what.padEnd(28)} ${detail}`); };
const GO = (w, d) => row("GO", w, d), WARN = (w, d) => row("WARN", w, d), NOGO = (w, d) => row("NO-GO", w, d);

// 1. dashboard
let st;
try { st = await api("/api/state"); GO("dashboard", `${BASE} · device ${st.device}`); }
catch (e) { NOGO("dashboard", `${BASE} unreachable (${e.message}) — docker compose up -d`); process.exit(1); }

// 2. fleet running
let nodes = st.procs.filter((p) => p.kind === "node" && p.running);
if (nodes.length < 5) {
  WARN("fleet", `${nodes.length} nodes running — booting the demo fleet`);
  await post("/api/demo");
  for (let i = 0; i < 20 && nodes.length < 5; i++) { await sleep(1000); st = await api("/api/state"); nodes = st.procs.filter((p) => p.kind === "node" && p.running); }
}
const lhs = st.procs.filter((p) => p.kind === "lighthouse" && p.running);
(nodes.length >= 5 && lhs.length >= 3 ? GO : NOGO)("fleet", `${nodes.length} nodes, ${lhs.length} lighthouses running`);

// 3. encryption
const enc = st.lighthouses.filter((l) => l.reachable);
(enc.length && enc.every((l) => l.signing) ? GO : NOGO)("encryption", enc.length ? `${enc.length} lighthouse${enc.length === 1 ? "" : "s"} report ${enc.every((l) => l.signing) ? "AES-256-GCM on" : "PLAINTEXT — set MESH_KEY"}` : "no lighthouse registry reachable");
const rejected = enc.reduce((n, l) => n + l.rejected, 0);
if (rejected) WARN("rejected packets", `${rejected} since start — a wrong key or an older build is knocking (Lighthouse tab shows the source)`);

// 4. local convergence, stable for 3 polls
const ids = nodes.map((p) => p.name);
let stable = 0, t0 = Date.now(), lastSets = "";
while (Date.now() - t0 < 60_000) {
  st = await api("/api/state");
  const views = st.views.filter((v) => ids.includes(v.id));
  const aliveSet = (v) => [...Object.entries(v.view).filter(([, e]) => e.status === "alive").map(([id]) => id), v.id].sort().join(",");
  const ok = views.length === ids.length && views.every((v) => v.reachable && ids.filter((n) => n !== v.id).every((n) => v.view[n]?.status === "alive")) && new Set(views.map(aliveSet)).size === 1;
  lastSets = views.map((v) => Object.values(v.view).filter((e) => e.status === "alive").length).join("/");
  if (ok) { if (++stable >= 3) break; } else stable = 0;
  await sleep(1000);
}
(stable >= 3 ? GO : NOGO)("local convergence", stable >= 3 ? `identical alive sets on all ${ids.length} nodes for 3 s (${((Date.now() - t0) / 1000).toFixed(0)} s)` : `views still differ after 60 s — alive counts ${lastSets}`);

// 5. remote devices
const byDevice = {};
for (const r of st.remotes) (byDevice[r.device ?? "?"] ??= []).push(r);
for (const d of EXPECT) {
  const rs = byDevice[d];
  if (!rs) { NOGO(`remote ${d}`, "not in any local view — is it up, on this build, with the same MESH_KEY?"); continue; }
  const alive = rs.filter((r) => r.status === "alive").length;
  const paths = [...new Set(rs.map((r) => r.path ?? "direct"))].join("+");
  const host = [...new Set(rs.map((r) => r.host))].join("/");
  (alive === rs.length ? GO : alive ? WARN : NOGO)(`remote ${d}`, `${alive}/${rs.length} alive via ${host} (${paths})`);
}
for (const d of Object.keys(byDevice)) if (!EXPECT.includes(d)) {
  const rs = byDevice[d]; const alive = rs.filter((r) => r.status === "alive").length;
  (alive === rs.length ? GO : WARN)(`remote ${d}`, `${alive}/${rs.length} alive (not in --expect)`);
}
if (!EXPECT.length && !Object.keys(byDevice).length) WARN("remote devices", "none seen — single-device demo (pass --expect to require some)");

// 6. map
const assets = Object.values(st.geo.entries).filter((e) => e.kind === "asset").length;
const placedDevices = Object.values(st.geo.entries).filter((e) => e.kind === "device").length;
(assets ? GO : WARN)("map layout", assets ? `${assets} defended assets, ${placedDevices} devices placed (table v${st.geo.version})` : "no defended assets — press 'seed Singapore demo layout' in Command");
try {
  const r = await fetch("https://tile.openstreetmap.org/11/1614/1017.png", { signal: AbortSignal.timeout(4_000) });
  (r.ok ? GO : WARN)("map tiles", r.ok ? "OpenStreetMap reachable" : `tile server answered ${r.status} — the bundled basemap will draw`);
} catch { WARN("map tiles", "OpenStreetMap unreachable from here — the map will use the bundled basemap (that is fine)"); }

// 7. cross-device signal timing — up to 3 attempts: a remote peer flapping between two
// nodes' ingest instants gives different fallback lists, which is churn, not a bug.
// Agreement on the first try is GO; on a retry WARN (the mesh is churning); never NO-GO.
{
  let sig = null, m = null, agreedAt = 0, sent = 0, attempt = 0, worst = "";
  for (attempt = 1; attempt <= 3 && !agreedAt; attempt++) {
    sent = Date.now();
    sig = await post("/api/signal", { threat: "missile", station: "preflight", note: `preflight check ${attempt}` });
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      const s = await api("/api/state");
      m = s.messages.find((x) => x.id === sig.id);
      if (m && m.seenBy.length >= ids.length && m.consistent) { agreedAt = Date.now(); break; }
    }
    if (!agreedAt) { worst = m ? `${m.agree}/${m.seenBy.length}` : "not stored"; await sleep(3000); }
    // tidy: neutralise our own track so the map is clean for the judges
    const tr = (await api("/api/state")).tracks.find((t) => t.trackId === sig.id);
    if (tr) await post(`/api/tracks/${sig.id}/neutralise`, { station: "preflight", override: tr.responsibleDevice !== st.device }).catch(() => {});
  }
  attempt--;
  const chainDevices = [...new Set([sig.assignment.primary, ...sig.assignment.fallbacks].map((n) => n.split("-").slice(1).join("-")).filter(Boolean))];
  if (agreedAt && attempt === 1) GO("signal agreement", `${m.seenBy.length}/${ids.length} agree after ${agreedAt - sent} ms · chain spans ${chainDevices.join(", ")}`);
  else if (agreedAt) WARN("signal agreement", `${m.seenBy.length}/${ids.length} agree after ${agreedAt - sent} ms, but only on attempt ${attempt} (earlier ${worst}) — a remote peer is flapping; see the churn row in DEMO.md`);
  else NOGO("signal agreement", `no full agreement in 3 attempts (last ${worst}) — a remote device is flapping; fix its path before the demo`);
}

// 8. optional drill: the runbook's self-healing step, timed
if (DRILL) {
  const victim = nodes.find((p) => p.name.startsWith("aegis")) ?? nodes[0];
  const others = ids.filter((n) => n !== victim.name);
  const tKill = Date.now();
  await post(`/api/procs/${victim.name}/kill`);
  let tSuspect = 0, tDead = 0;
  while (Date.now() - tKill < 30_000) {
    await sleep(250);
    const s = await api("/api/state");
    const statuses = s.views.filter((v) => others.includes(v.id)).map((v) => v.view[victim.name]?.status);
    if (!tSuspect && statuses.some((x) => x === "suspect" || x === "dead")) tSuspect = Date.now();
    if (statuses.length === others.length && statuses.every((x) => x === "dead")) { tDead = Date.now(); break; }
  }
  (tDead ? GO : NOGO)("drill: kill → dead", tDead ? `${victim.name}: first suspicion after ${tSuspect - tKill} ms, dead on all ${others.length} peers after ${tDead - tKill} ms` : "not convicted dead within 30 s");
  const tRevive = Date.now();
  await post(`/api/procs/${victim.name}/start`);
  let tAlive = 0;
  while (Date.now() - tRevive < 30_000) {
    await sleep(250);
    const s = await api("/api/state");
    const statuses = s.views.filter((v) => others.includes(v.id)).map((v) => v.view[victim.name]?.status);
    if (statuses.length === others.length && statuses.every((x) => x === "alive")) { tAlive = Date.now(); break; }
  }
  (tAlive ? GO : NOGO)("drill: revive → alive", tAlive ? `${victim.name} back alive on all peers after ${tAlive - tRevive} ms (it refuted with a higher incarnation)` : "not alive again within 30 s");
}

console.log();
console.log(nogo ? `NO-GO — ${nogo} blocking check${nogo === 1 ? "" : "s"} above` : "GO — ready for the judges");
process.exit(nogo ? 1 : 0);
