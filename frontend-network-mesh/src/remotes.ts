import type { MeshState, RemoteMember } from "./types";
import { deviceOf } from "./defense";

/** Name of the machine a remote member runs on: what it reported, else the
 *  suffix of its id, else its address. */
export function remoteDevice(r: RemoteMember): string {
  return r.device ?? deviceOf(r.id) ?? r.host;
}

export interface RemoteDevice {
  device: string;
  host: string; // most common address among its members
  members: RemoteMember[];
  alive: number;
}

/** Remote members grouped by device, devices sorted by name. */
export function groupRemotes(remotes: RemoteMember[]): RemoteDevice[] {
  const groups = new Map<string, RemoteMember[]>();
  for (const r of remotes) {
    const d = remoteDevice(r);
    groups.set(d, [...(groups.get(d) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([device, members]) => {
      const hosts = new Map<string, number>();
      for (const m of members) hosts.set(m.host, (hosts.get(m.host) ?? 0) + 1);
      const host = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { device, host, members: [...members].sort((a, b) => a.id.localeCompare(b.id)), alive: members.filter((m) => m.status === "alive").length };
    })
    .sort((a, b) => a.device.localeCompare(b.device));
}

/** Address of the node a message came from, if it is a known remote member. */
export function hostOfNode(state: MeshState, nodeId: string): string | undefined {
  return state.remotes.find((r) => r.id === nodeId)?.host;
}
