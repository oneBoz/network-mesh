#!/usr/bin/env node
/**
 * smoke.mjs — end-to-end check against a running dashboard (native or Docker).
 *
 *   node scripts/smoke.mjs [http://127.0.0.1:7070]
 *
 * Boots the demo fleet, waits until every node sees every other node alive,
 * fires one threat of each type, and asserts the mesh answered. Exit 0 = pass.
 */
const BASE = process.argv[2] ?? process.env.MESH_URL ?? "http://127.0.0.1:7070";
const NODES = ["maelstrom", "aegis", "smartfalcon", "edgefuse", "wisl"];
const THREATS = ["missile", "swarm", "aircraft", "emp"];
const CONVERGE_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, init) {
  const r = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(5_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${r.status} ${JSON.stringify(body)}`);
  return body;
}
function fail(msg) { console.error(`\nFAIL: ${msg}`); process.exit(1); }

console.log(`dashboard: ${BASE}`);
await api("/api/state").catch((e) => fail(`dashboard not reachable (${e.message}) — is it running?`));

console.log("booting demo fleet (3 lighthouses + 5 defense nodes)…");
await api("/api/demo", { method: "POST" });

const t0 = Date.now();
let converged = false;
while (Date.now() - t0 < CONVERGE_TIMEOUT_MS) {
  const state = await api("/api/state");
  const views = state.views.filter((v) => NODES.includes(v.id));
  const ok = views.length === NODES.length && views.every((v) =>
    v.reachable && NODES.filter((n) => n !== v.id).every((n) => v.view[n]?.status === "alive"));
  const alive = views.map((v) => `${v.id}:${Object.values(v.view).filter((x) => x.status === "alive").length}`).join(" ");
  process.stdout.write(`\r  ${((Date.now() - t0) / 1000).toFixed(0)}s  alive peers per node → ${alive}      `);
  if (ok) { converged = true; break; }
  await sleep(1_000);
}
console.log();
if (!converged) fail(`mesh did not converge within ${CONVERGE_TIMEOUT_MS / 1000}s`);
console.log(`converged: every node sees the other ${NODES.length - 1} alive (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

for (const threat of THREATS) {
  const a = await api("/api/threat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threat }) });
  if (!a.primary) fail(`threat ${threat} had no primary`);
  console.log(`threat ${threat.padEnd(8)} via ${a.via.padEnd(11)} → primary ${a.primary}${a.fallbacks.length ? `, fallbacks ${a.fallbacks.join(" → ")}` : ""}`);
}

const res = await api("/api/resolve/aegis");
if (!res.healthy?.length) fail("resolve/aegis returned no healthy instance");
console.log(`resolve aegis via ${res.via} → ${res.healthy.map((h) => h.id).join(", ")}`);
console.log("\nPASS");
