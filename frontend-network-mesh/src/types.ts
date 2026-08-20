/**
 * types.ts — the dashboard API contract.
 *
 * Mirror of backend/src/types.ts in the backend-network-mesh repo. The two
 * repos are developed separately, so this copy is the frontend's source of
 * truth — update both sides when the contract changes.
 */
export type ProcKind = "lighthouse" | "node";
export type NodeStatus = "alive" | "suspect" | "dead";
export type ThreatType = "missile" | "swarm" | "aircraft" | "emp";

/** Defense capabilities a node gossips inside its peer record. */
export interface Skills {
  threats: ThreatType[];
  layer: number; // engagement priority — lower engages first
  cost: number; // tie-break within a layer, cheaper first
}

/** One threat injection and the mesh's ranked answer to it.
 *  Broadcast as SSE `threat` events and kept in MeshState.threats. */
export interface ThreatAssignmentEvent {
  threatId: string;
  threat: ThreatType;
  via: string; // node whose /threat endpoint was called
  primary?: string; // undefined => no alive coverage ("threat leaked")
  fallbacks: string[];
  ranked: { id: string; service?: string; layer: number; cost: number }[];
  ts: number;
}

/** How to launch one mesh process. `name` doubles as the node id. */
export interface ProcSpec {
  name: string;
  kind: ProcKind;
  port: number; // UDP gossip port (lighthouse: its only port)
  httpPort?: number; // node query API port
  service?: string;
}

export interface ProcState extends ProcSpec {
  running: boolean;
  pid?: number;
}

export interface ViewEntry {
  status: NodeStatus;
  inc: number;
  since: number;
  info?: { id: string; host: string; port: number; httpPort?: number; service?: string; skills?: Skills };
}

/** One node's opinion of the whole mesh, fetched from its /members API. */
export interface NodeView {
  id: string;
  reachable: boolean; // did the poller get an answer this round?
  inc: number;
  service?: string;
  view: Record<string, ViewEntry>;
}

export interface MeshState {
  ts: number;
  procs: ProcState[];
  views: NodeView[];
  threats: ThreatAssignmentEvent[]; // most recent last, capped
}

export interface LogEvent {
  source: string; // proc name or "backend"
  line: string;
  ts: number;
}
