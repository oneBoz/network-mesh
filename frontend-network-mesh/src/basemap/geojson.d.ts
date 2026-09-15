// The bundled offline basemap (singapore.geo.json, built by scripts/build-basemap.mjs)
// is loaded with a dynamic import only when tiles are unreachable or the operator
// asks for it; type it here instead of letting tsc infer 130 KB of coordinates.
declare module "*.geo.json" {
  import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
  const data: FeatureCollection<Polygon | MultiPolygon, { name: string }> & { attribution?: string };
  export default data;
}
