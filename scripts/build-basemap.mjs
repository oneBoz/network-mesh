#!/usr/bin/env node
/**
 * build-basemap.mjs — produce the bundled offline basemap of Singapore.
 *
 *   node scripts/build-basemap.mjs <planning-areas.geojson> [tolerance-deg]
 *
 * Input: the URA Master Plan 2014 planning-area polygons (55 features, ~4 MB)
 * as published on data.gov.sg (Singapore Open Data Licence), e.g. the copy at
 * https://github.com/yinshanyang/singapore (maps/2-planning-area.geojson).
 * Output: frontend-network-mesh/src/basemap/singapore.geo.json — the same
 * polygons simplified with Douglas-Peucker (default 0.0003°, ≈ 33 m) and
 * rounded to 4 decimals (≈ 11 m), ~60 KB, so the dashboard can draw the
 * island itself when OpenStreetMap tiles are unreachable (MapPanel.tsx).
 *
 * The output is committed; this script only needs to run when the source or
 * the tolerance changes.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , input, tolArg] = process.argv;
if (!input) {
  console.error("usage: node scripts/build-basemap.mjs <planning-areas.geojson> [tolerance-deg]");
  process.exit(2);
}
const TOL = Number(tolArg ?? 0.0003);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend-network-mesh", "src", "basemap", "singapore.geo.json");

/** Perpendicular distance (in degrees, flat approximation — fine at 1° N) from p to segment a–b. */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker on an open polyline (iterative, so long rings do not blow the stack). */
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (v) => Math.round(v * 1e4) / 1e4;

function simplifyRing(ring, tol) {
  // Treat the ring as an open line from vertex 0 around to the last (== first) vertex.
  const out = simplify(ring, tol).map(([x, y]) => [round(x), round(y)]);
  // Drop consecutive duplicates introduced by rounding.
  const dedup = out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
  if (dedup.length && (dedup[0][0] !== dedup.at(-1)[0] || dedup[0][1] !== dedup.at(-1)[1])) dedup.push(dedup[0]);
  return dedup.length >= 4 ? dedup : null; // a closed ring needs at least 3 distinct vertices
}

function extent(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return Math.max(maxX - minX, maxY - minY);
}

const title = (s) => s.toLowerCase().replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());

const src = JSON.parse(readFileSync(input, "utf8"));
let before = 0, after = 0;
const features = [];
for (const f of src.features) {
  const g = f.geometry;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const kept = [];
  for (const poly of polys) {
    for (const r of poly) before += r.length;
    const outer = simplifyRing(poly[0], TOL);
    if (!outer) continue;
    // Islets smaller than ~200 m across add nothing at the zooms we draw; keep a feature's largest ring regardless.
    if (extent(outer) < 0.002 && polys.length > 1) continue;
    const holes = poly.slice(1).map((r) => simplifyRing(r, TOL)).filter(Boolean);
    kept.push([outer, ...holes]);
  }
  if (!kept.length) {
    // Everything was tiny — keep the biggest original ring so no planning area disappears.
    const biggest = polys.map((p) => p[0]).sort((a, b) => extent(b) - extent(a))[0];
    const ring = simplifyRing(biggest, TOL / 4);
    if (ring) kept.push([ring]);
  }
  for (const poly of kept) for (const r of poly) after += r.length;
  const name = title(String(f.properties?.name ?? f.properties?.PLN_AREA_N ?? "?"));
  features.push({
    type: "Feature",
    properties: { name },
    geometry: kept.length === 1 ? { type: "Polygon", coordinates: kept[0] } : { type: "MultiPolygon", coordinates: kept },
  });
}

const out = {
  type: "FeatureCollection",
  // Kept in the file so the attribution survives copies of the data.
  attribution: "Planning areas: URA Master Plan 2014 via data.gov.sg — Singapore Open Data Licence. Simplified for offline use.",
  features,
};
mkdirSync(dirname(OUT), { recursive: true });
const text = JSON.stringify(out);
writeFileSync(OUT, text + "\n");
console.log(`${features.length} planning areas, ${before} → ${after} vertices (tolerance ${TOL}°), ${(text.length / 1024).toFixed(0)} KB → ${OUT}`);
