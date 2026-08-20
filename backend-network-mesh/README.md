# mesh-ts-backend

A self-healing overlay mesh in TypeScript, using **only Node built-ins** (`dgram`, `http`, `crypto`), plus the dashboard **control plane** that spawns and observes mesh processes. It implements the same architecture as the Nebula + Consul design: lighthouses broker joins, SWIM gossip tracks membership, and every node answers service-discovery queries from its own local view — no single point of failure anywhere.

The dashboard UI lives in its own repo: **frontend-network-mesh** (Vite + React). Check both out side by side; the frontend's dev server proxies `/api` to this backend on port 7000.

## Layout

    src/protocol.ts        Wire format, message types, optional HMAC signing
    src/skills.ts          Defense skill table + deterministic threat matchmaking
    src/swim.ts            SWIM membership engine (pure state machine, no I/O)
    src/lighthouse.ts      Join broker — never in the data path
    src/node.ts            Regular server: gossip loop + HTTP query API
    src/cli.ts             Shared arg parsing + logging for the two executables
    backend/src/           Dashboard control plane (Node built-ins only):
                           spawns/kills mesh processes, polls every node's
                           /members API, streams state + logs over SSE
    scripts/demo.sh        Boots 3 lighthouses + 5 defense-system nodes locally

## Demo fleet: the defense layers

The demo mesh runs one server site per defense system:

| Site / service | Layer | Role |
|---|---|---|
| `maelstrom` | Defense Layer 1 | **MAELSTROM Command** (anti-swarm) — takes down higher-level threats using high-speed propulsion |
| `aegis` | Defense Layer 2 | **AEGIS** — good close-combat fighting capabilities |
| `smartfalcon` | Defense Layer 3 | **SmartFalcon** — similar to AEGIS; if AEGIS fails, SmartFalcon is ready to take down |
| `edgefuse` | Defense Layer 4 | **EdgeFuse** (leader: Lee Jinho) — on-sensor fused detection for counter-swarm; if layers 2 and 3 fail, EdgeFuse goes for the kill |
| `wisl` | EMP Defense | **WISL** (anti-swarm) — EMP jamming / e-warfare specialist ("jack of none, master of one"); economically smarter to send for EMF threats than Layer 1 missiles |

## Setup

**Prerequisites:** Node.js 20+ (uses built-in `fetch` and `AbortSignal.timeout`) and npm.

    npm install       # dev tooling (tsx, typescript)
    npm run typecheck # verify everything compiles

Optional: put `MESH_KEY=<shared secret>` in your environment before starting
anything if you want signed gossip — the control plane passes it through to
every process it spawns.

## Run the control plane

    npm run dev    # dashboard control plane on http://127.0.0.1:7000

Then start the frontend dev server from the **frontend-network-mesh** repo
(`npm run dev` there, UI on http://localhost:5173), or `POST /api/demo` and
drive everything with curl. The control plane binds to loopback only — it can
spawn and kill processes, so it is deliberately unreachable from other machines.

If a production build of the dashboard exists it is served at
http://127.0.0.1:7000 — by default from a sibling checkout at
`../frontend-network-mesh/dist`; set `FRONTEND_DIST=/path/to/dist` to override.

### Control-plane API (all JSON)

    GET    /api/state                  current MeshState
    GET    /api/events                 SSE stream: `state` + `log` events
    POST   /api/demo                   boot 3 lighthouses + 5 defense-system nodes
    POST   /api/stop-all               crash everything (specs kept for revive)
    POST   /api/quit                   stop everything AND exit the backend
    POST   /api/lighthouses            {port?} → spawn a lighthouse
    POST   /api/nodes                  {id?, service?} → spawn a node
    POST   /api/procs/<name>/kill      crash a process (spec kept)
    POST   /api/procs/<name>/start     revive a crashed process
    DELETE /api/procs/<name>           kill + forget
    GET    /api/resolve/<svc>?via=<id> service discovery through a live node
    POST   /api/threat                 {threat, via?} → inject a threat through a
                                       node; returns the mesh's ranked assignment
                                       and broadcasts it as an SSE `threat` event

The shapes returned by this API are defined in `backend/src/types.ts` — the
frontend repo keeps a mirror in `src/types.ts`; update both when the contract
changes.

## Run a mesh by hand

Every process simulates one physical server. Ports stand in for machines, so you can run a whole "multi-site" fleet on one laptop — or spread the same commands across real machines by changing the lighthouse addresses.

    # terminal 1-3: lighthouses (your "3 sites")
    npx tsx src/lighthouse.ts --port 5001
    npx tsx src/lighthouse.ts --port 5002
    npx tsx src/lighthouse.ts --port 5003

    # terminal 4+: nodes
    npx tsx src/node.ts --id maelstrom --port 4001 --http 8001 --service maelstrom \
      --lighthouses 127.0.0.1:5001,127.0.0.1:5002,127.0.0.1:5003

Or boot everything at once:

    npm run demo

Optional message signing (built-in crypto, satisfies "only my servers can talk"):

    export MESH_KEY=some-shared-secret   # set on every process; unsigned packets are dropped

## Query the mesh

Ask **any** node — each answers from its own gossip-derived view, exactly like a local Consul agent:

    curl -s localhost:8001/members         # maelstrom's full membership view
    curl -s localhost:8001/resolve/aegis   # healthy AEGIS instances, per maelstrom
    curl -s localhost:8004/resolve/aegis   # same question to edgefuse — should converge to the same answer

## Threat matchmaking — the mesh as one entity

Every node carries its defense skills (threat coverage, layer priority, cost —
see `src/skills.ts`) inside its gossiped peer record, so every node can run the
same **deterministic matchmaking function** over its own view: filter alive
systems that cover the threat, rank by layer → cost → id. No leader, no
coordination round-trip — whichever node ingests a threat computes the answer
any other node would, then floods the event so all of them log the identical
assignment. Escalation is emergent: SWIM convicts the primary, the alive
filter drops it, the next matchmake returns the fallback.

    curl -s -X POST localhost:8001/threat -d '{"threat":"missile"}'   # primary: aegis, fallbacks: smartfalcon → edgefuse
    curl -s localhost:8005/engage/missile   # ask wisl instead — IDENTICAL answer
    curl -s localhost:8001/engage/emp       # wisl (cheap jamming beats Layer-1 missiles)

    scripts/threat-demo.sh                  # scripted kill/revive escalation ladder

## Stress-test playbook

| Scenario | How | What you should see |
|---|---|---|
| Node crash | `kill $(pgrep -f 'id aegis')` | Peers log `aegis: alive → suspect` within ~1s, `suspect → dead` ~5s later; aegis vanishes from every `/resolve` answer (SmartFalcon's cue to step in) |
| Node revive | rerun the aegis command | aegis rejoins via a lighthouse, bumps its incarnation to refute stale "dead" rumors, reappears in DNS |
| Add a server | start a node with a new `--id`/ports | Joins via one lighthouse; **no other process is touched** — the plug-and-play property |
| Lighthouse failure | kill 1–2 lighthouses | Nothing happens to existing traffic; joins still work via survivors |
| Total lighthouse loss | kill all 3 | Existing mesh keeps gossiping and resolving; brand-new joins retry until a lighthouse returns — but a *restarted* node still rejoins through any surviving peer (saved peer list + peer-assisted join) |
| Partition | `sudo iptables -A INPUT -p udp --dport 4003 -j DROP` (repeat per "site" port) | Isolated nodes get marked suspect→dead by the far side and vice versa; on restore, views re-merge within ~30s (resurrection probes revive not-yet-pruned peers; the lighthouse's announce refresh re-teaches pruned addresses) |
| Slow network | run nodes on separate machines over Wi-Fi/VPN | Same behavior, longer convergence — tune `PROTOCOL_PERIOD_MS` / `SUSPECT_TIMEOUT_MS` in node.ts |

## How it maps to the real stack

| This project | Production equivalent |
|---|---|
| `lighthouse.ts` | Nebula lighthouses |
| SWIM loop in `node.ts` + `swim.ts` | Consul/Serf memberlist gossip |
| `/resolve/<service>` | `service.service.consul` DNS |
| `MESH_KEY` HMAC | Nebula certificates + Noise encryption |
| (not included) | Encrypted tunnels, NAT traversal, Prometheus metrics |

## Robustness features

- **Indirect probes (`ping-req`).** A direct probe timeout asks 2 other members to try their path before suspecting — one lossy link doesn't convict a healthy node.
- **Resurrection probes.** Every 5th protocol period, ping one known-dead peer: nobody normally probes the dead, so this is what lets a falsely convicted node (or a healed partition) refute and come back.
- **Anti-entropy via announce.** Lighthouses answer the 30s keepalive with a peer-list refresh, so nodes that pruned each other during a partition re-learn the far side's addresses automatically.
- **Peer-assisted join.** Any mesh node answers `join` like a lighthouse. Combined with the peer list each node saves to the OS temp dir every 30s, a restarted node rejoins even with every lighthouse down.
- **Adaptive suspicion + jitter.** The suspect→dead window scales with view size (~log n, like memberlist) so refutations have time to spread in bigger meshes, and all timers carry ±10% jitter to avoid lockstep probe bursts.
- **Bounded packets.** Rumors and peer addresses are capped per message (least-gossiped-first), keeping datagrams under the MTU as the mesh grows.
- **Visible drops.** With `MESH_KEY` set, rejected frames log *why* (key mismatch, clock skew) instead of silently impersonating a dead peer.
- **Duplicate-ID guard.** A lighthouse refuses a join for an id that is actively registered from a different address — two machines can't fight an incarnation war over one identity.

## Known simplifications

- **HMAC signs but doesn't encrypt.** Signed frames carry a timestamp and are rejected outside a 60s window (replay protection), but payloads are readable on the wire. For real deployments, run this traffic inside Nebula/WireGuard, or add Node's built-in TLS/DTLS.
- **Membership persistence only.** The saved peer list is a rejoin bootstrap; a restarted node still starts with a fresh view (which gossip repopulates in seconds).
- **No NAT keepalive tuning.** Hole-punched NAT mappings can expire between probes on very quiet meshes; real deployments (Nebula) send explicit keepalives per tunnel.
