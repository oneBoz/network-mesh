import { useState } from "react";
import { api } from "./api";
import type { MeshState } from "./types";

/** Service discovery: ask any live node "who serves X?" — the Consul-DNS demo. */
export function ResolvePanel({ state }: { state: MeshState }) {
  const [service, setService] = useState("aegis");
  const [via, setVia] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const liveNodes = state.procs.filter((p) => p.kind === "node" && p.running);

  const ask = async () => {
    try {
      const r = await api.resolve(service, via || undefined);
      setResult(JSON.stringify(r, null, 2));
    } catch (e) {
      setResult(`error: ${(e as Error).message}`);
    }
  };

  return (
    <div className="panel">
      <h2>Resolve a service</h2>
      <div className="row">
        <input size={10} value={service} onChange={(e) => setService(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()} />
        <span style={{ color: "var(--muted)" }}>via</span>
        <select value={via} onChange={(e) => setVia(e.target.value)}>
          <option value="">any node</option>
          {liveNodes.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <button className="primary" onClick={ask} disabled={!service || !liveNodes.length}>
          Ask
        </button>
      </div>
      {result && <div className="resolve-result">{result}</div>}
    </div>
  );
}
