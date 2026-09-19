import { useState } from "react";
import { api } from "./api";
import type { MeshState } from "./types";
import { Field } from "./ui";

/** Service discovery: ask any live node "who serves X?" — the Consul-DNS demo. Rendered inside a disclosure. */
export function ResolvePanel({ state }: { state: MeshState }) {
  const [service, setService] = useState("aegis");
  const [via, setVia] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running);

  const ask = async () => {
    try { setResult(JSON.stringify(await api.resolve(service, via || undefined), null, 2)); }
    catch (e) { setResult(`error: ${(e as Error).message}`); }
  };

  return (
    <>
      <div className="row end">
        <Field label="Service"><input id="resolve-service" size={12} value={service} onChange={(e) => setService(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} /></Field>
        <Field label="Via">
          <select id="resolve-via" value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">Any node</option>
            {liveNodes.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </Field>
        <button type="button" className="btn primary" onClick={ask} disabled={!service || !liveNodes.length}>Ask</button>
      </div>
      {result && <div className="resolve-result">{result}</div>}
    </>
  );
}
