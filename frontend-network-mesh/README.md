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

Command mode is laid out by what an operator does (see `docs/WORKLOG.md`,
2026-09-19, for the design rationale and the accessibility checklist):

- **Status strip** — local nodes alive, remote devices reachable, live
  targets, agreement on the last signal; each tile's stripe is its state.
- **Situation** — the map (default) and the topology behind one segmented
  control, with the engagement timeline docked beside them. Topology glyphs
  encode belief as shape and word before colour (filled = alive, dashed ring =
  suspect, cross badge = dead, dashed red ring = process actually down); every
  glyph is keyboard-focusable and arrow keys nudge it.
- **Fleet** — add nodes/lighthouses, Kill (immediate) and Revive them; Remove
  sits under the … menu and asks first. Stop all in the header asks first too.
- **Inject a threat** — missile / swarm / aircraft / EMP, ingested by any (or a
  chosen) node. The mesh's ranked answer (primary → fallbacks) is shown in the
  panel, the primary pulses on the topology graph, and every node's identical
  assignment line appears in the log. Kill the primary, re-inject, and watch
  the next layer step in.
- **GCS signals** — every signal on the mesh with its chain, agreement and
  lifecycle badge.
- **Diagnostics**, collapsed by default — the convergence matrix (each row is
  one node's `/members` view of everyone else), the service resolver (Consul
  DNS through any live node) and the live log.

`src/ui.tsx` holds the shared primitives (pills, status glyphs, threat icons,
labelled fields, disclosures, the … menu, the confirmation sheet); the token
set lives at the top of `src/styles.css`. Dark only, by decision.

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
