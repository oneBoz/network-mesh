import type { GeoEntry, GeoTable, InboxMessage, LogEvent, MeshState, ThreatAssignmentEvent, ThreatType } from "./types";

async function post(path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Tolerate a non-JSON body (proxy error pages etc.) — report the status instead.
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data;
}

export const api = {
  bootDemo: () => post("/api/demo"),
  stopAll: () => post("/api/stop-all"),
  addNode: (id?: string, service?: string) => post("/api/nodes", { id, service }),
  addLighthouse: (port?: number) => post("/api/lighthouses", port ? { port } : {}),
  kill: (name: string) => post(`/api/procs/${encodeURIComponent(name)}/kill`),
  revive: (name: string) => post(`/api/procs/${encodeURIComponent(name)}/start`),
  remove: async (name: string) => {
    const r = await fetch(`/api/procs/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `${r.status} ${r.statusText}`);
    }
  },
  /** Location table: place/move a device or asset (persisted + broadcast), or remove one. */
  placeGeo: async (id: string, entry: GeoEntry): Promise<GeoTable> => {
    const r = await fetch(`/api/geo/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(entry),
    });
    const data = (await r.json().catch(() => ({}))) as GeoTable & { error?: string };
    if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
    return data;
  },
  removeGeo: async (id: string): Promise<GeoTable> => {
    const r = await fetch(`/api/geo/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = (await r.json().catch(() => ({}))) as GeoTable & { error?: string };
    if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
    return data;
  },
  /** GCS signal: a data-channel message flooded to every device; each node
   *  matchmakes it and the answer comes back with the stored message. */
  sendSignal: (threat: ThreatType, station: string, note?: string) =>
    post("/api/signal", { threat, station, note: note || undefined }) as Promise<InboxMessage & { via: string }>,
  injectThreat: (threat: ThreatType, via?: string) =>
    post("/api/threat", { threat, via: via || undefined }) as Promise<ThreatAssignmentEvent>,
  resolve: async (service: string, via?: string): Promise<unknown> => {
    const q = via ? `?via=${encodeURIComponent(via)}` : "";
    const r = await fetch(`/api/resolve/${encodeURIComponent(service)}${q}`);
    // Even a 404/503 body is an informative answer (NXDOMAIN, no live node) —
    // only a non-JSON body means something actually broke.
    return r.json().catch(() => {
      throw new Error(`resolve failed: ${r.status} ${r.statusText}`);
    });
  },
};

/** Subscribe to the backend's SSE stream. Returns an unsubscribe function.
 *  `onConnected(false)` fires when the stream drops (EventSource keeps
 *  reconnecting on its own; the next state event flips it back to true). */
export function subscribe(
  onState: (s: MeshState) => void,
  onLog: (e: LogEvent) => void,
  onConnected?: (up: boolean) => void,
  onThreat?: (t: ThreatAssignmentEvent) => void,
  onMessage?: (m: InboxMessage) => void,
  onGeo?: (g: GeoTable) => void
): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    onState(JSON.parse((e as MessageEvent).data));
    onConnected?.(true);
  });
  es.addEventListener("log", (e) => onLog(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("threat", (e) => onThreat?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("message", (e) => onMessage?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("geo", (e) => onGeo?.(JSON.parse((e as MessageEvent).data)));
  es.onerror = () => onConnected?.(false);
  return () => es.close();
}
