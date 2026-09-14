# mesh-dashboard

Vite + React dashboard for the **mesh-ts** overlay mesh: live topology, convergence matrix, fleet controls, service resolver, and a streaming log.

The mesh itself and the dashboard's control plane live in the **backend-network-mesh** repo. This repo is pure presentation — it talks to the backend's REST + SSE API on port 7070 and never touches the mesh directly.

## Setup

**Prerequisites:** Node.js 20+ and npm.

    npm install
    npm run typecheck

## Development

Start the backend first (in the backend-network-mesh repo):

    npm run dev        # control plane on http://127.0.0.1:7070

Then here:

    npm run dev        # Vite dev server on http://localhost:5173

Open http://localhost:5173 and press **Boot demo mesh**. Every lighthouse and
node the dashboard shows is a *real OS process* spawned by the backend — the
UI just renders what the control plane streams:

- **Topology** — node color is what the *mesh believes* (majority across all
  nodes' views); a dashed red ring means the process is actually down.
- **Convergence matrix** — each row is one node's `/members` view of everyone
  else. Disagreement after a crash, healing after a revive.
- **Fleet** — add nodes/lighthouses, crash (`kill`) and `revive` them. Add a
  lighthouse before adding your first node — a node needs one to join.
- **Inject a threat** — missile / swarm / aircraft / emp, ingested by any (or a
  chosen) node. The mesh's ranked answer (primary → fallbacks) is shown in the
  panel, the primary pulses on the topology graph, and every node's identical
  assignment line appears in the log. Kill the primary, re-inject, and watch
  the next layer step in.
- **Resolve** — service discovery through any live node, like Consul DNS.

All `/api` traffic (including the SSE stream) is proxied to `127.0.0.1:7070`
by the Vite dev server — see `vite.config.ts`.

## Production build

    npm run build      # typechecks, then emits dist/

The backend serves `dist/` itself at http://127.0.0.1:7070 when this repo is
checked out as a sibling directory (`../frontend-network-mesh`); set
`FRONTEND_DIST=/path/to/dist` on the backend to serve it from anywhere else.

## API contract

`src/types.ts` mirrors `backend/src/types.ts` in the backend repo. The two
repos are developed separately, so update both files when the contract changes.

## Bonus: browser simulator

`sim/mesh-simulator.tsx` is a self-contained React component that simulates
the same SWIM algorithm entirely in the browser (no backend needed) — useful
for demos and for understanding the protocol. It is typechecked with the app
but not bundled into it.
