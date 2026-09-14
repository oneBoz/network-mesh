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
  info?: { id: string; host: string; port: number; httpPort?: number; service?: string; skills?: Skills; device?: string; advertise?: string };
}

/** One node's opinion of the whole mesh, fetched from its /members API. */
export interface NodeView {
  id: string;
  reachable: boolean; // did the poller get an answer this round?
  inc: number;
  service?: string;
  view: Record<string, ViewEntry>;
}

/** A mesh member that is NOT a process of this dashboard: a node on another
 *  machine, learned purely through gossip (it shows up in the local nodes'
 *  /members views). Nothing here is polled over the internet; status is the
 *  consensus of the local observers, exactly like the topology colouring. */
export interface RemoteMember {
  id: string;
  device?: string; // machine name it reported (--device / DEVICE_NAME)
  host: string; // address the local nodes reach it at (public IP or advertised host)
  port: number;
  httpPort?: number;
  service?: string;
  skills?: Skills;
  status: NodeStatus; // majority across local reachable observers, ties pessimistic
  inc: number;
  since: number; // earliest `since` any local observer reports
  observers: number; // local nodes that currently hold an entry for it
  votes: Record<NodeStatus, number>;
}

/** The mesh's ranked answer to a threat, as computed by a node. */
export interface Assignment {
  threatId: string;
  threat: ThreatType;
  primary?: string;
  fallbacks: string[];
  ranked: { id: string; service?: string; layer: number; cost: number }[];
}

/**
 * A data-channel message as reported by the local nodes' /inbox APIs, merged
 * by id across every local node that received it. Kind "gcs.signal" carries a
 * threat report from a Ground Control Station; each node ran matchmaking on it
 * and `assignment` is what they decided (identical everywhere by construction —
 * `consistent` says whether the local nodes actually agreed).
 */
export interface InboxMessage {
  id: string;
  at: number; // sender's clock
  kind: string;
  from: { node: string; device?: string; station?: string };
  to?: string;
  body: Record<string, unknown>; // gcs.signal: { threat, note?, pos? }
  assignment?: Assignment;
  receivedAt: number; // first local receipt
  seenBy: string[]; // local nodes that reported it
  agree: number; // of those, how many computed the same assignment as the first report
  consistent: boolean; // agree === seenBy.length
}

export interface MeshState {
  ts: number;
  device: string; // name of the machine this dashboard runs on (DEVICE_NAME)
  procs: ProcState[];
  views: NodeView[];
  threats: ThreatAssignmentEvent[]; // most recent last, capped
  remotes: RemoteMember[]; // members on other machines, derived from views
  extraLighthouses: string[]; // host:port of lighthouses on other machines (EXTRA_LIGHTHOUSES)
  messages: InboxMessage[]; // data-channel messages, most recent last, capped
}

export interface LogEvent {
  source: string; // proc name or "backend"
  line: string;
  ts: number;
}
