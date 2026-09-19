import { useState } from "react";
import { api } from "./api";
import type { MeshState, NodeStatus, ProcState } from "./types";
import { consensus } from "./consensus";
import { defenseTooltip, systemOf } from "./defense";
import { deviceStatus, groupRemotes } from "./remotes";
import { Field, MoreMenu, PanelHead, Pill, STATUS_WORD, StatusGlyph, useNow } from "./ui";
import type { ConfirmRequest } from "./ui";

/** Fleet controls: add servers, crash them, revive them — plus a read-only
 *  list of members on other machines (you cannot crash someone else's process).
 *  Kill is immediate (the demo needs it fast); Remove asks first. */
export function ProcPanel({ state, onError, confirm }: { state: MeshState; onError: (m: string) => void; confirm: (req: ConfirmRequest) => void }) {
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [newService, setNewService] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const now = useNow();

  const run = (p: Promise<unknown>) => p.catch((e: Error) => onError(e.message));
  const observers = state.views.filter((v) => v.reachable).length;
  const hasRemoteSection = state.remotes.length > 0 || state.extraLighthouses.length > 0;

  /** Belief about a local process: process down beats everything; otherwise the mesh consensus. */
  const beliefOf = (p: ProcState): NodeStatus | "unknown" | "down" | "lh" => {
    if (!p.running) return "down";
    if (p.kind === "lighthouse") return "lh";
    return consensus(state, p.name);
  };
  const suspectFor = (id: string): number | undefined => {
    const since = state.views.filter((v) => v.reachable).map((v) => v.view[id]).filter((e) => e?.status === "suspect").map((e) => e!.since);
    return since.length ? now - Math.min(...since) : undefined;
  };
  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="panel">
      <PanelHead title="Fleet" sub="this device" right={<>
        <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>Add node…</button>
        <button type="button" className="btn sm" onClick={() => run(api.addLighthouse())}>Add lighthouse</button>
      </>} />
      {adding && (
        <form className="well add-form row end" onSubmit={(e) => { e.preventDefault(); run(api.addNode(newId || undefined, newService || undefined)); setNewId(""); setNewService(""); setAdding(false); }}>
          <Field label="Node id"><input id="add-node-id" size={9} placeholder="auto" value={newId} onChange={(e) => setNewId(e.target.value)} /></Field>
          <Field label="Service"><input id="add-node-service" size={11} placeholder="e.g. aegis" value={newService} onChange={(e) => setNewService(e.target.value)} /></Field>
          <button type="submit" className="btn sm primary">Add node</button>
          <button type="button" className="btn sm quiet" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      )}

      <div className="list" style={{ marginTop: 8 }}>
        {state.procs.map((p) => {
          const belief = beliefOf(p);
          const sys = systemOf(p.name, p.service);
          const susp = belief === "suspect" ? suspectFor(p.name) : undefined;
          const word = belief === "lh" ? "running" : STATUS_WORD[belief];
          const detail = p.kind === "lighthouse"
            ? `lighthouse · udp ${p.port}${!p.running ? ` · ${word}` : ""}`
            : `${sys?.layer ?? p.service ?? "node"} · ${word}${susp !== undefined ? `, ${Math.round(susp / 1000)} s` : ""} · udp ${p.port}`;
          return (
            <div className="item" key={p.name} title={defenseTooltip(p.name, p.service) ?? `${p.name} · udp/${p.port}${p.httpPort ? ` http/${p.httpPort}` : ""}`}>
              <StatusGlyph status={belief} />
              <span className="nm" style={p.kind === "lighthouse" ? { color: "var(--lh)" } : undefined}>
                {sys?.name ?? p.name}
                <small>{detail}{sys && p.name !== p.service ? ` · ${p.name}` : ""}{p.pid && p.running ? ` · pid ${p.pid}` : ""}</small>
              </span>
              <span className="acts">
                {p.running
                  ? <button type="button" className="btn sm destructive" onClick={() => run(api.kill(p.name))}>Kill</button>
                  : <button type="button" className="btn sm primary" onClick={() => run(api.revive(p.name))}>Revive</button>}
                <MoreMenu label={`More actions for ${p.name}`} items={[
                  { label: "Remove from fleet…", destructive: true, onClick: () => confirm({
                    title: `Remove ${p.name}?`, confirmLabel: "Remove", destructive: true,
                    body: p.running ? "The process is killed and forgotten; it cannot be revived from here afterwards." : "The stopped process is forgotten; it cannot be revived from here afterwards.",
                    onConfirm: () => run(api.remove(p.name)),
                  }) },
                ]} />
              </span>
            </div>
          );
        })}
        {!state.procs.length && <p className="empty">Nothing running. Boot the demo or add servers above.</p>}
      </div>

      {hasRemoteSection && (
        <>
          <PanelHead title="Other devices" sub="via internet" />
          <div className="list">
            {state.extraLighthouses.map((addr) => (
              <div className="item remote" key={`xlh-${addr}`} title="External lighthouse (EXTRA_LIGHTHOUSES): every local node joins it too, so this fleet merges with peers that use the same lighthouse">
                <StatusGlyph status="lh" />
                <span className="nm" style={{ color: "var(--lh)" }}>lighthouse<small className="mono">{addr}</small><small>external join broker</small></span>
                <span />
              </div>
            ))}
            {groupRemotes(state.remotes).map((d) => {
              const open = expanded.has(d.device);
              const status = deviceStatus(d);
              return (
                <div className="item remote" key={d.device}>
                  <StatusGlyph status={status} />
                  <span className="nm">{d.device}<small className="mono">{d.host}</small><small>{d.alive} of {d.members.length} alive{d.members.some((m) => m.path === "relay") ? " · via relay" : ""}</small></span>
                  <span className="acts"><button type="button" className="btn sm quiet" aria-expanded={open} onClick={() => toggle(d.device)}>{open ? "Hide" : "Details"}</button></span>
                  {open && d.members.map((r) => (
                    <div className="item-detail" key={r.id} style={{ paddingLeft: 28 }}>
                      <StatusGlyph status={r.status} />
                      <b style={{ color: "var(--text)" }}>{systemOf(r.id, r.service)?.name ?? r.id}</b>
                      <span className="mono">{r.id} · udp {r.port}</span>
                      <span>{STATUS_WORD[r.status]} · seen by {r.observers}/{observers} · votes {r.votes.alive}/{r.votes.suspect}/{r.votes.dead} · inc {r.inc}</span>
                      {r.path === "relay" && <Pill tone="info" title="no direct NAT path from this device — reached through a relay (e.g. the VPS node)">via relay</Pill>}
                    </div>
                  ))}
                </div>
              );
            })}
            {!state.remotes.length && <p className="empty">No remote peers yet — they appear here when a node on another machine joins the lighthouse above.</p>}
          </div>
        </>
      )}
    </div>
  );
}
