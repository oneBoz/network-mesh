/**
 * types.ts — shapes shared between the dashboard backend and frontend.
 * (frontend/src/types.ts re-exports these, so this file is the single source.)
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
  port: number; // UDP gossip port
  httpPort?: number; // node: query API port; lighthouse: loopback registry API port
  service?: string;
}

/** One entry of a lighthouse's registry: a node that joined or announced recently. */
export interface RegistryEntry {
  id: string;
  device?: string;
  service?: string;
  host: string; // observed (or advertised) address the lighthouse hands out
  port: number;
  httpPort?: number;
  advertise?: string;
  inc: number;
  lastSeen: number;
  ageMs: number;
}

/** A local lighthouse as seen through its registry API. */
export interface LighthouseView {
  name: string;
  port: number;
  reachable: boolean;
  signing: boolean;
  registered: number;
  rejected: number; // packets dropped for a bad/missing signature or clock skew since start
  joins: number;
  uptimeMs: number;
  staleMs: number;
  entries: RegistryEntry[];
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
  paths?: Record<string, "direct" | "relay">; // peers this node can only reach through a relay
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
  path?: "direct" | "relay"; // "relay" when every local observer reaches it only via a relay (no direct NAT path)
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

/** A point on the map: a device (all its nodes share it) or a named defended
 *  asset (airbase, port…) with no node and no status. */
export interface GeoEntry {
  kind: "device" | "asset";
  lat: number;
  lng: number;
  label?: string;
}

/**
 * The location table. Owned by Command: every edit bumps `version`, is
 * persisted by the control plane that made it, and is broadcast to the whole
 * mesh as a `geo.locations` message; receivers keep the highest version
 * (last writer wins) and persist it too. Keyed by device name or asset id.
 */
export interface GeoTable {
  version: number;
  updatedBy: string; // device that made the last edit
  updatedAt: number;
  entries: Record<string, GeoEntry>;
}


/** Engagement lifecycle of one target, as computed by a node (see src/engagement.ts). */
export type TrackState = "detected" | "engaging" | "neutralised" | "lost";
export interface TrackPosition { seq: number; t: number; lat: number; lng: number; alt?: number; heading?: number; speed?: number; eta?: number }
export interface Track {
  trackId: string;
  threat: ThreatType;
  detectedAt: number;
  origin: { node: string; device?: string; station?: string };
  note?: string;
  chain: string[]; // ranked node ids, primary first
  responsibleIndex: number;
  responsibleSince: number;
  responsibleNode?: string;
  responsibleDevice?: string;
  state: TrackState;
  escalations: { at: number; from?: string; to?: string; reason: "dead" | "timeout" | "handover"; note?: string }[];
  engagingAt?: number;
  neutralised?: { at: number; node: string; device?: string; station?: string; override?: boolean };
  rejected: { at: number; node: string; device?: string; action: string; reason: string }[];
  positions: TrackPosition[];
  lastUpdateAt?: number;
  lostAt?: number;
}

/** A track merged across the local nodes: first report, plus how many agree on state + responsible. */
export interface TrackView extends Track {
  seenBy: string[];
  agree: number;
  consistent: boolean;
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
  geo: GeoTable; // locations of devices and defended assets (see GeoTable)
  lighthouses: LighthouseView[]; // local lighthouses' registries (Lighthouse mode)
  tracks: TrackView[]; // engagement lifecycle per target, merged across local nodes
}

export interface LogEvent {
  source: string; // proc name or "backend"
  line: string;
  ts: number;
}
