/**
 * geo.ts — the location table (devices + defended assets) and its persistence.
 *
 * Command-owned, last-writer-wins by version. The control plane that edits it
 * persists it and broadcasts it over the data channel; every other control
 * plane that receives a newer version persists that. So any Command device
 * (or a restarted one) converges on the same table without a central store.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GeoEntry, GeoTable } from "./types.js";

export const EMPTY_GEO: GeoTable = { version: 0, updatedBy: "", updatedAt: 0, entries: {} };

export class GeoStore {
  private table: GeoTable = EMPTY_GEO;
  private readonly file: string;

  constructor(dataDir: string, private readonly device: string) {
    this.file = join(dataDir, "geo.json");
    try {
      mkdirSync(dataDir, { recursive: true });
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as GeoTable;
      if (GeoStore.valid(parsed)) this.table = parsed;
    } catch {
      // first run, or unreadable file — start empty and ask the mesh
    }
  }

  get(): GeoTable {
    return this.table;
  }

  /** Local edit: bump the version, persist, return the new table (caller broadcasts). */
  set(id: string, entry: GeoEntry): GeoTable {
    const entries = { ...this.table.entries, [id]: entry };
    return this.commit({ version: this.table.version + 1, updatedBy: this.device, updatedAt: Date.now(), entries });
  }

  /** Several entries in one version bump (the demo seed). Unchanged table if there is nothing to add. */
  setMany(entries: Record<string, GeoEntry>): GeoTable {
    if (!Object.keys(entries).length) return this.table;
    return this.commit({ version: this.table.version + 1, updatedBy: this.device, updatedAt: Date.now(), entries: { ...this.table.entries, ...entries } });
  }

  remove(id: string): GeoTable {
    if (!(id in this.table.entries)) return this.table;
    const { [id]: _gone, ...entries } = this.table.entries;
    return this.commit({ version: this.table.version + 1, updatedBy: this.device, updatedAt: Date.now(), entries });
  }

  /** A table received from the mesh: adopt it only if it is newer. Returns true if adopted. */
  adopt(candidate: unknown): boolean {
    if (!GeoStore.valid(candidate) || candidate.version <= this.table.version) return false;
    this.commit(candidate);
    return true;
  }

  private commit(next: GeoTable): GeoTable {
    this.table = next;
    try {
      // Atomic replace so a crash mid-write never leaves a torn file.
      writeFileSync(this.file + ".tmp", JSON.stringify(next, null, 2));
      renameSync(this.file + ".tmp", this.file);
    } catch (err) {
      console.log(`[geo] could not persist ${this.file}: ${(err as Error).message}`);
    }
    return next;
  }

  static valid(t: unknown): t is GeoTable {
    const x = t as GeoTable;
    return !!x && typeof x.version === "number" && typeof x.updatedBy === "string"
      && typeof x.updatedAt === "number" && !!x.entries && typeof x.entries === "object"
      && Object.values(x.entries).every(GeoStore.validEntry);
  }

  static validEntry(e: unknown): e is GeoEntry {
    const x = e as GeoEntry;
    return !!x && (x.kind === "device" || x.kind === "asset")
      && typeof x.lat === "number" && x.lat >= -90 && x.lat <= 90
      && typeof x.lng === "number" && x.lng >= -180 && x.lng <= 180
      && (x.label === undefined || typeof x.label === "string");
  }
}
