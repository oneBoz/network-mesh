# network-mesh

A self-healing overlay mesh for a distributed defense network, in TypeScript
with **Node built-ins only** (`dgram`, `http`, `crypto`). Lighthouses broker
joins, SWIM gossip tracks membership, and every node answers service-discovery
and threat-matchmaking queries from its own local view, so there is no leader
and no single point of failure. A live dashboard spawns, crashes and revives
real mesh processes and shows the fleet converge.

| Package | What it is |
|---|---|
| [`backend-network-mesh/`](backend-network-mesh/README.md) | The mesh (`src/`) and the dashboard control plane (`backend/`) |
| [`frontend-network-mesh/`](frontend-network-mesh/README.md) | The dashboard UI (Vite + React), served by the control plane |
| [`PLAN.md`](PLAN.md) | Roadmap to a multi-device, internet-wide, encrypted product |

---

## Run it (Docker, recommended)

Requirements: Docker Desktop 4.x or later with Compose v2 (`docker compose`).
Tested on Apple Silicon (arm64); the image is multi-arch.

```sh
git clone <this repo> network-mesh && cd network-mesh
cp .env.example .env          # optional: defaults work as-is
docker compose up
```

Then open **http://localhost:7070** and click **Boot demo**, or from another
terminal:

```sh
node scripts/smoke.mjs        # boots the fleet, waits for convergence, fires 4 threats
```

The whole system is one container: the control plane on port 7070 spawns
3 lighthouses and 5 defense-system nodes as child processes, exactly as the
native version does. `docker compose down` stops everything.

### What you should see

In the dashboard within ~5 seconds of **Boot demo**:

- Topology graph with 3 lighthouses (`lh-5001..5003`) and 5 nodes:
  `maelstrom`, `aegis`, `smartfalcon`, `edgefuse`, `wisl`, all green.
- The convergence matrix fully green: every node sees every other node alive.
- The event log showing each node join and the `alive` transitions.

Then try the threat ladder:

| Action | Expected |
|---|---|
| Inject `missile` | primary **aegis**, fallbacks smartfalcon → edgefuse, and every node logs the identical assignment |
| Inject `emp` | primary **wisl** (cheap jamming beats Layer-1 missiles) |
| Kill `aegis`, wait ~6 s, inject `missile` again | peers log `aegis: alive → suspect → dead`; primary becomes **smartfalcon** |
| Revive `aegis` | it rejoins, logs `refuting rumor that I am dead — incarnation now 1`, and is primary again |
| Kill all three lighthouses | nothing changes for the running mesh; only brand-new joins would wait |

The smoke test prints the same story as text and exits 0 on success:

```
converged: every node sees the other 4 alive (3.0s)
threat missile  via wisl   → primary aegis, fallbacks smartfalcon → edgefuse
threat swarm    via wisl   → primary maelstrom, fallbacks edgefuse → wisl
threat aircraft via aegis  → primary aegis, fallbacks smartfalcon → edgefuse
threat emp      via aegis  → primary wisl
resolve aegis via smartfalcon → aegis
PASS
```

### Environment variables (`.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `MESH_KEY` | `hackathon-demo-key` | Shared HMAC secret. Every process (local and remote) must match. Empty = unsigned mesh. |
| `EXTRA_LIGHTHOUSES` | empty | `host:port,host:port` of lighthouses on other machines. Every node the dashboard spawns joins them too. |

Sample data is built in: the 5 defense systems and their skill table live in
[`backend-network-mesh/src/skills.ts`](backend-network-mesh/src/skills.ts);
threats are `missile`, `swarm`, `aircraft`, `emp`.

---

## Run it natively (no Docker)

Requirements: **Node.js 22 or 24 LTS** (tested with 22.18 and 24.21) and npm 10+.
On a clean Mac, install Node from the official `.pkg` at
https://nodejs.org/en/download (choose macOS, ARM64). No Homebrew, no Xcode
tools needed. Both packages have `package-lock.json` files and exact versions,
and `npm ci` installs precisely those.

```sh
git clone <this repo> network-mesh && cd network-mesh

# 1. build the dashboard
cd frontend-network-mesh && npm ci && npm run build && cd ..

# 2. run the control plane (serves the dashboard build from ../frontend-network-mesh/dist)
cd backend-network-mesh && npm ci
export MESH_KEY=hackathon-demo-key      # optional
npm run dev                             # → http://127.0.0.1:7070
```

Open http://127.0.0.1:7070 and click **Boot demo**, or run
`node scripts/smoke.mjs` from the repo root. Ctrl+C (or `POST /api/quit`)
stops the control plane and every child process.

macOS will show a firewall dialog the first time Node binds a UDP port.
Click **Allow**.

---

## Devices on different networks (real internet)

The local demo is self-contained. To show the same mesh spanning machines
behind different routers, stand up one **remote site** on any Linux VPS with
a public IP and let every other machine join it. Nothing else changes.

On the VPS (Docker installed, inbound **UDP 5001 and 4001** open):

```sh
PUBLIC_IP=<vps public ip> MESH_KEY=hackathon-demo-key \
  docker compose -f docker-compose.remote.yml up -d
```

That runs one lighthouse and one defense node (`vps-1`, service `aegis` by
default; override with `SITE_ID` / `SITE_SERVICE`). On every other machine,
set in `.env`:

```
MESH_KEY=hackathon-demo-key
EXTRA_LIGHTHOUSES=<vps public ip>:5001
```

and `docker compose up` as usual. After **Boot demo**, the local nodes join
the VPS lighthouse too. The lighthouse records the NAT-mapped public address
it observes for each node and hands it out, so the local fleet and the VPS
node probe each other directly across the internet (UDP hole punching).
Within a few seconds `vps-1` appears alive in every local node's view, and a
threat asked on either side returns the same ranked assignment.

How it works and what it needs:

- **No port forwarding, no public IP on the local machine.** Only the VPS
  needs one. Outbound UDP must be allowed on the local network.
- `--advertise <public ip>` on the VPS node is what makes this work: it joins
  its own lighthouse over loopback, and without it the lighthouse would hand
  `127.0.0.1` to the rest of the world.
- Symmetric NAT (some mobile carriers and corporate networks) breaks direct
  probes between two NATed devices, but every device still reaches the VPS
  node, and the mesh keeps membership through it (indirect probes).
- Encryption is the next step: traffic is HMAC-signed and replay-protected
  but not encrypted. See PLAN.md for the WireGuard/Nebula/Noise options.

Two devices on the **same LAN** need no VPS at all: run the lighthouse on
either one and point the other at `<its LAN ip>:5001` via `EXTRA_LIGHTHOUSES`.
The compose file publishes UDP 4001-4008 and 5001-5003 for exactly this.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `http://localhost:7070` works but you tried 7000 and got `403 Forbidden` from `AirTunes` | macOS AirPlay Receiver owns port 7000 on every Mac. The dashboard deliberately uses **7070**. |
| `docker compose up` fails binding a UDP port | Another mesh instance (native or Docker) is running. Stop it, or remove the UDP `ports:` lines (they are only needed for peers on other machines). |
| Nodes log `dropping packets: bad HMAC signature` | `MESH_KEY` differs between machines. |
| Nodes log `timestamp outside the replay window` | Clocks differ by more than 60 s. Enable NTP. |
| Remote peer appears then goes `suspect`/`dead` | Its UDP port is not open, or a symmetric NAT is in the path. Check `vps-1` is reachable and the VPS firewall allows UDP 4001. |
| Dashboard shows nothing after **Boot demo** | Check `docker compose logs` (or the terminal) for `EADDRINUSE`; the demo needs UDP 4001-4005, 5001-5003 and TCP 8001-8005 free inside its network namespace. |

---

## Layout

```
Dockerfile                  multi-stage build: dashboard + control plane in one pinned Node 24 image
docker-compose.yml          the whole system, `docker compose up`
docker-compose.remote.yml   optional remote site (lighthouse + node) for a public VPS
.env.example                MESH_KEY, EXTRA_LIGHTHOUSES
scripts/smoke.mjs           end-to-end check against a running dashboard
backend-network-mesh/       mesh + control plane (see its README for the protocol and API)
frontend-network-mesh/      dashboard UI
PLAN.md                     roadmap
```
