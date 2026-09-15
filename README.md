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
| [`docs/WORKLOG.md`](docs/WORKLOG.md) | What was built and why, current state of every machine (Azure VM access, secrets, open items) — read this first when continuing on another device |
| [`docs/ADDING-A-DEVICE.md`](docs/ADDING-A-DEVICE.md) | Step-by-step guide to joining a new machine to the mesh (other network, same LAN, or a new VPS) |

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
node scripts/scenario.mjs     # seeds the map, runs "two swarms from the south-east", follows the lifecycle
node scripts/preflight.mjs --expect azure-vm --drill   # judging-day GO / NO-GO: encryption, convergence, remotes, map, timed signal + kill/revive drill
```

For the judging session itself, [`docs/DEMO.md`](docs/DEMO.md) is the
minute-by-minute runbook.

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
| Switch to **GCS**, report `swarm` | Latest engagement shows **MAELSTROM Command** with fallbacks; back in Command, the signal is in the feed with `5/5 agree` and the topology rings light up |
| In Command press **seed Singapore demo layout**, then in GCS **run scenario** `saturation` | Three trajectories cross the map at 1 Hz, each with its own responsible system; press **NEUTRALISED** on the responsible device for a ✔, or let one land for ✖ **IMPACT** |
| Press **🗺 offline map** | The island is drawn from the bundled basemap; markers and trajectories are unchanged and the page makes no network request |

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

### Three modes: Command, GCS, Lighthouse

The header has a **Command / GCS / Lighthouse** switch (also `?mode=gcs` or
`?mode=lighthouse` in the URL). All run on the same control plane, so one
device can be all three: open several tabs. The page scrolls; nothing is
squeezed to fit one screen.

- **Command** is the full picture: topology, convergence matrix, fleet
  controls, threat injection, live log, and a **GCS signals** feed showing every
  signal on the mesh with the actions taken.
- **GCS** (Ground Control Station) is the operator screen: name your station,
  press a threat button, and the mesh decides. The **Latest engagement** card
  and the feed update live for *every* station's signals, including ones sent
  from other devices over the internet.
- **Lighthouse** shows what this device's lighthouses see: each one's registry
  (who is registered, from which device, the address it hands out, incarnation,
  last seen), joins and **rejected packets** since start (someone knocking
  with the wrong key), whether encryption is on, and a log filtered to lighthouse
  events — joins in green, moves and conflicts in yellow, rejections in red.
  Each lighthouse exposes this on a loopback-only registry API
  (`--http`, ports 9001+), never on the network.

A signal is a data-channel message (`kind: gcs.signal`) originated by one local
node and flooded across the mesh with a TTL, dedupe by id, and **relays first**:
peers that advertise a public address (the VPS node) are always among the first
hops, so a signal crossing NATs takes the reliable path before the hole-punched
ones. Every node that receives it runs the same deterministic matchmaking and
stores the result in its inbox. The dashboard merges its local nodes' inboxes
and shows how many computed the identical answer (`5/5 agree`). No station
talks to another station; they all just read the mesh.

**Engagement lifecycle.** Every signal is also a *target* with a replicated
state machine (`backend-network-mesh/src/engagement.ts`, tested in
`test/engagement.test.ts`): detected → engaging → neutralised, or lost. The
device that runs the assigned system is *responsible*; only it may press
**ENGAGE**, **NEUTRALISED** or **hand over** (GCS mode), and every node checks
that independently — anyone else's attempt is recorded as rejected and shown.
If the responsible node is convicted dead, or the per-threat engage timeout
passes (45-60 s), responsibility escalates to the next alive fallback and every
panel shows the handover. Command mode has an **Engagement timeline** and an
explicit, logged **override** for neutralising without being responsible.
Each row shows how many local nodes agree on state and responsible.

**Trajectories.** GCS mode can launch a *simulated incoming target*: pick
missile, swarm or aircraft, a target from the map (a device or defended asset),
a time to impact, then click the map for the launch origin. This device's
control plane drives the track and streams `track.update` at 1 Hz to the whole
mesh; every map shows the trajectory (colour by threat, heading arrow, ETA,
dashed line to the target, responsible device), smoothed between updates.
If the responsible GCS neutralises it the stream stops and the head turns into
✔; if it reaches the target while still live it becomes ✖ **IMPACT** — the
defence leaked. At most three simulated tracks per device; **cancel** sends
`track.lost`. EMP has no trajectory and stays a point signal. While a track is
live its detection is re-flooded every 15 s, so a device that boots or
reconnects mid-track still gets the full picture.

**Scripted scenarios.** The GCS launcher also has **run scenario**:
`cruise-north`, `two-swarms-se`, `saturation` (missile, aircraft and swarm from
three directions within 20 s) and `probe-aircraft` (slow enough for the engage
timeout to escalate). A scenario is a list of launches relative to *one*
target — delay, threat, bearing and range from the target, time to impact
([`scenarios.ts`](backend-network-mesh/backend/src/scenarios.ts)) — so the
same script attacks whichever asset you pick. From a terminal,
`node scripts/scenario.mjs saturation` runs one and prints every lifecycle
transition until the tracks end. Command mode's map has **seed Singapore demo
layout**: six real defended assets (Changi and Paya Lebar airbases, Tuas Port,
Jurong Island, Sembawang, Marina Bay) plus every device not yet on the map,
so a fresh machine is demo-ready in one click.

**Offline basemap.** The map uses OpenStreetMap tiles while it can reach them.
The moment a tile fails to load, a bundled 58 KB GeoJSON of Singapore's 55
planning areas (URA Master Plan 2014 via data.gov.sg, Singapore Open Data
Licence; built by `scripts/build-basemap.mjs`) is drawn *beneath* the tiles,
so a flaky link shows the island wherever a tile is missing. **🗺 offline map**
in the map header switches to the bundled basemap only — the page then makes
no network request at all — and the choice is remembered per browser. Markers
and trajectories are identical either way.

Under the hood each node exposes `POST /send {kind, body, to?, station?}` and
`GET /inbox?after=<ms>`; the control plane wraps them as `POST /api/signal`
and streams new messages over SSE.

### Environment variables (`.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `MESH_KEY` | placeholder | The mesh's access key: every packet is encrypted and authenticated with a key derived from it (AES-256-GCM), so anyone without it can neither read nor forge traffic, and lighthouses/nodes reject anything else. Any value works locally; to join a real mesh get its key from the operator privately. Public lighthouses refuse to start without one. |
| `EXTRA_LIGHTHOUSES` | empty | `host:port,host:port` of lighthouses on other machines. Every node the dashboard spawns joins them too. |
| `DEVICE_NAME` | `local-device` (Docker) / hostname (native) | Label for this machine on other devices' dashboards and on the signals it sends; also the id suffix when several devices boot the demo. |
| `ADVERTISE` | empty | Public IP of *this* host. Only for a dashboard running on a VPS (see the host-network override). |
| `MESH_PROFILE` | `local` | Timer preset: `local`, `internet`, or `mobile` for a phone hotspot / carrier NAT (longer ack and suspect windows, 5 s keepalive). |
| `DATA_DIR` | `/data` (Docker) / `.data` (native) | Where the control plane persists the location table. |
| `NODE_API_TOKEN` | random per start | Bearer token the control plane hands every node it spawns; a node's query API (`/members`, `/send`, `/threat`…) answers only requests that carry it. Set it yourself only if you want to `curl` a node directly. |

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
export MESH_KEY=<any value locally; the real key to join a mesh>   # optional
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
PUBLIC_IP=<vps public ip> MESH_KEY=<a long random secret> \
  docker compose -f docker-compose.remote.yml up -d
```

That runs one lighthouse and one defense node (`vps-1`, service `aegis` by
default; override with `SITE_ID` / `SITE_SERVICE`). On every other machine,
set in `.env`:

```
MESH_KEY=<the same secret>
EXTRA_LIGHTHOUSES=<vps public ip>:5001
```

and `docker compose up` as usual. After **Boot demo**, the local nodes join
the VPS lighthouse too. The lighthouse records the NAT-mapped public address
it observes for each node and hands it out, so the local fleet and the VPS
node probe each other directly across the internet (UDP hole punching).
Within a few seconds `vps-1` appears alive in every local node's view, and a
threat asked on either side returns the same ranked assignment.

The dashboard shows the other machine as a first-class member:

- Header: an **n/m remote · internet** counter.
- Topology: the external lighthouse as a dashed diamond marked INTERNET, and
  each remote **device** as one card (name, IP, alive count, systems) linked to
  the local nodes that believe its members alive. Threat rings and fallback
  ranks roll up onto the card. **expand devices** switches to one glyph per
  remote node in a column per device; **links on/off** hides the gossip web.
  Both toggles persist in the browser.
- Convergence matrix: remote nodes as extra columns (⟡). Rows stay local,
  because the dashboard never polls another machine; what it knows about a
  remote comes purely from gossip, which is the point.
- **Other devices** list in the fleet panel: address, service, consensus
  status and how many local observers see it. No kill or revive buttons, since
  you cannot crash someone else's process.
- **Map** (Command mode): every device and defended asset from the location
  table on a Singapore map (OpenStreetMap tiles). Pick a device or type a new
  asset name in the side list, click the map to place it, drag to move, × to
  remove an asset. Edits are persisted (Docker volume `mesh-data`) and
  broadcast, so every device's map shows the same table within seconds; GCS
  mode shows the map read-only.

How it works and what it needs:

- **No port forwarding, no public IP on the local machine.** Only the VPS
  needs one. Outbound UDP must be allowed on the local network.
- `--advertise <public ip>` on the VPS node is what makes this work: it joins
  its own lighthouse over loopback, and without it the lighthouse would hand
  `127.0.0.1` to the rest of the world.
- Symmetric NAT (some mobile carriers and corporate networks) breaks direct
  probes between two NATed devices, but every device still reaches the VPS
  node, and the mesh keeps membership through it (indirect probes).
- Traffic is encrypted end to end (AES-256-GCM, key derived from `MESH_KEY`
  with HKDF, 60 s replay window). What is still missing is per-device
  identity: one shared key means anyone holding it can claim any device name.
  See PLAN.md Phase 6 for the Noise/Ed25519 design.

**Several devices booting the demo.** Node ids must be unique across the whole
mesh, so whenever a fleet joins external lighthouses (or advertises a public
address) Boot demo names its nodes `aegis-<device>`, `wisl-<device>` and so on,
from `DEVICE_NAME`. Service names, skills and matchmaking are unchanged, and
the dashboard still shows the system names. Two Mac minis can therefore both
press Boot demo and end up as one ten-node mesh: each Command panel shows the
other's five nodes as remotes, and a GCS signal from either appears on both.

**A full dashboard on the VPS** (the VPS as a complete second device with its
own Command and GCS screens) uses the host-network override:

```sh
ADVERTISE=<vps public ip> DEVICE_NAME=vps \
  docker compose -p mesh-dashboard -f docker-compose.yml -f docker-compose.host.yml up -d --build
ssh -L 7070:127.0.0.1:7070 <user>@<vps public ip>     # then open http://localhost:7070
```

Its lighthouse on UDP 5001 replaces the lightweight remote site, so other
devices keep using `EXTRA_LIGHTHOUSES=<vps public ip>:5001`. Open UDP 4001-4010
and 5001-5003 on the VPS firewall.

**Two devices on the same LAN / behind the same router** (two Mac minis on one
Wi-Fi is the typical judging setup): point them at **each other's LAN address**,
with or without the VPS:

```
# Mac mini A (LAN 192.168.0.13)          # Mac mini B (LAN 192.168.0.14)
EXTRA_LIGHTHOUSES=192.168.0.14:5001      EXTRA_LIGHTHOUSES=192.168.0.13:5001
DEVICE_NAME=mini-a                       DEVICE_NAME=mini-b
```

Add `,<vps public ip>:5001` to both to include the VPS. This matters: two
devices behind the *same* router learn each other's **public** address from an
outside lighthouse, and most home routers do not hairpin traffic to their own
public IP, so direct probes between the two fail and the mesh keeps them alive
only through relays. A LAN lighthouse hands out LAN addresses, which is what
those two devices should use. The compose file publishes UDP 4001-4008 and
5001-5003 on the host for exactly this. (Find a Mac's LAN address with
`ipconfig getifaddr en0`.)

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `http://localhost:7070` works but you tried 7000 and got `403 Forbidden` from `AirTunes` | macOS AirPlay Receiver owns port 7000 on every Mac. The dashboard deliberately uses **7070**. |
| `docker compose up` fails binding a UDP port | Another mesh instance (native or Docker) is running. Stop it, or remove the UDP `ports:` lines (they are only needed for peers on other machines). |
| Nodes log `authentication failed — MESH_KEY mismatch` | `MESH_KEY` differs between machines. `unknown frame version` means the other machine runs a build from before encryption — rebuild it. |
| Nodes log `timestamp outside the replay window` | Clocks differ by more than 60 s. Enable NTP. |
| Remote peer appears then goes `suspect`/`dead` | Its UDP port is not open, or a symmetric NAT is in the path. Check `vps-1` is reachable and the VPS firewall allows UDP 4001. |
| Dashboard shows nothing after **Boot demo** | Check `docker compose logs` (or the terminal) for `EADDRINUSE`; the demo needs UDP 4001-4005, 5001-5003 and TCP 8001-8005 free inside its network namespace. |

---

## Layout

```
Dockerfile                  multi-stage build: dashboard + control plane in one pinned Node 24 image
docker-compose.yml          the whole system, `docker compose up`
docker-compose.remote.yml   optional lightweight remote site (lighthouse + node) for a public VPS
docker-compose.host.yml     override: the full dashboard on a public VPS as a second device
docs/DEMO.md                minute-by-minute runbook for the judging session
docs/WORKLOG.md             work log + current state of every machine
docs/ADDING-A-DEVICE.md     how to add a device
.env.example                MESH_KEY, EXTRA_LIGHTHOUSES
scripts/smoke.mjs           end-to-end check against a running dashboard
scripts/scenario.mjs        run a scripted attack and follow the lifecycle from the terminal
scripts/preflight.mjs       judging-day GO / NO-GO checklist with timings (--drill rehearses kill/revive)
scripts/build-basemap.mjs   regenerate the bundled offline basemap from the data.gov.sg polygons
backend-network-mesh/       mesh + control plane (see its README for the protocol and API)
frontend-network-mesh/      dashboard UI
PLAN.md                     roadmap
```
