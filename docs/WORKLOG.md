# Work log

A running record of what was built, why, and where things stand, so the
project can be picked up from any machine after a `git pull`. Newest at the
bottom of each section. Update this file whenever something non-obvious
changes (a decision, a bug found in the field, a machine's configuration).

Companion documents: [`ADDING-A-DEVICE.md`](ADDING-A-DEVICE.md) for onboarding
a machine, [`../PLAN.md`](../PLAN.md) for the roadmap, the root
[`README.md`](../README.md) for running the demo.

---

## Current state (2026-09-14, evening)

### Machines in the mesh

| Device name | What | Where | Runs |
|---|---|---|---|
| `dingyi-mac` | Dingyi's Mac, home Wi-Fi, LAN `192.168.0.13`, public `116.88.197.32` | Singapore | Full dashboard via `docker compose up`, `EXTRA_LIGHTHOUSES=23.100.103.160:5001` |
| `mac02` | Second Mac on the **same router** as `dingyi-mac` | Singapore | Full dashboard (was on an older build at time of writing — rebuild it) |
| `azure-vm` | Azure VM `mesh-vps`, Standard_B2pls_v2 (2 vCPU, 4 GB, arm64), Ubuntu 24.04, resource group `mesh-rg`, region Japan East | Tokyo | Full dashboard with host networking (`docker-compose.host.yml`), `ADVERTISE=23.100.103.160`; its lighthouse on UDP 5001 is the one every other device joins |

Azure VM access: static public IP **23.100.103.160**, user `azureuser`, SSH key
is the RSA key of the Mac that created it (`~/.ssh/id_rsa`). From another
device, add your own key first:

```sh
az login
az vm user update -g mesh-rg -n mesh-vps -u azureuser --ssh-key-value "$(cat ~/.ssh/id_ed25519.pub)"
ssh azureuser@23.100.103.160
```

Network security group `mesh-vpsNSG` allows inbound TCP 22, UDP 4001-4010,
UDP 5001-5003. The code lives in `~/network-mesh` on the VM, copied with
`rsync` (not a git clone); `~/network-mesh/.env` holds
`PUBLIC_IP`, `MESH_KEY=hackathon-demo-key`, `DEVICE_NAME=azure-vm`.

Start / update the VM site (from the repo root on any machine that can SSH in):

```sh
rsync -az --exclude node_modules --exclude .git --exclude dist --exclude .env --exclude .DS_Store ./ azureuser@23.100.103.160:~/network-mesh/
ssh azureuser@23.100.103.160 'cd ~/network-mesh && ADVERTISE=23.100.103.160 DEVICE_NAME=azure-vm sudo -E docker compose -p mesh-dashboard -f docker-compose.yml -f docker-compose.host.yml up -d --build && curl -s -X POST 127.0.0.1:7070/api/demo'
```

Its dashboard is loopback-only; open it with `ssh -L 7070:127.0.0.1:7070 azureuser@23.100.103.160` then http://localhost:7070.

Cost control: `az vm deallocate -g mesh-rg -n mesh-vps` between sessions,
`az vm start -g mesh-rg -n mesh-vps` before (IP is static). Subscription is
"Azure for Students"; allowed regions are only indiasouthcentral, japaneast,
centralindia, koreacentral, malaysiawest, and only arm64 B-series had capacity.

### Shared secret

Every device uses `MESH_KEY=hackathon-demo-key`. Change it everywhere at once
or nothing talks.

### Known open items

- `mac02` must be rebuilt on the current code and both Macs should list each
  other's **LAN** lighthouse (see the same-router note below). Until then the
  Mac side logs many false suspicions that originate on `mac02`.
- No encryption yet (HMAC-signed plaintext). Roadmap Phase 6.
- Node query API (`/members`, `/threat`, `/send`) is unauthenticated on
  `0.0.0.0`; only UDP is opened on the VM firewall, so it is not reachable
  there, but Phase 1 of the plan (bearer token) is still to do.
- Tests and CI (Phase 0) not started.

---

## Log

### 2026-09-07 — Plan

- Wrote `PLAN.md`: roadmap to a multi-device, internet-wide, encrypted mesh
  app; picked Tailscale-then-Nebula as the transport strategy.

### 2026-09-14 — Cross-network communication, Docker, Azure

**Constraint change.** The hackathon judges run submissions on vanilla Apple
Silicon Mac minis via `docker compose up`, so Tailscale (Phase 2 in the plan)
was dropped. Replaced by a public lighthouse on a VPS: the existing
observed-source-address logic in `lighthouse.ts` already does UDP hole
punching.

**Dockerised.**
- Multi-stage `Dockerfile` on pinned `node:24.21.0-alpine3.24`, multi-arch,
  builds the frontend and typechecks the backend; runs as the `node` user.
- `docker-compose.yml`: whole system in one container, dashboard bound
  loopback-only on the host, UDP 4001-4008 / 5001-5003 published for peers.
- `docker-compose.remote.yml`: lightweight VPS site (lighthouse + one node).
- `docker-compose.host.yml`: override to run the **full** dashboard on a VPS
  with host networking (the VM runs this now).
- `.env.example`, root `.gitignore`, `.dockerignore`, `scripts/smoke.mjs`
  (boots the fleet, waits for convergence, fires threats and a GCS signal).
- Exact dependency versions in both `package.json` files, `engines`, `.nvmrc`.
- **Port 7000 → 7070**: macOS AirPlay Receiver owns 7000 on every Mac and
  answers HTTP with a bare 403.

**Control plane.**
- `HOST` / `PORT` env (Docker binds 0.0.0.0 inside the container).
- `EXTRA_LIGHTHOUSES`: every spawned node also joins lighthouses on other
  machines.
- `DEVICE_NAME` (default hostname) passed to nodes as `--device`; also used
  as the demo id suffix (`aegis-<device>`) whenever the fleet joins external
  lighthouses or advertises, so several devices can boot the demo into one
  mesh without id collisions.
- `ADVERTISE`: public host passed to nodes as `--advertise`.
- Derives `remotes` (members on other machines) from local nodes' views with
  majority-vote status; exposes `extraLighthouses`, `device`, `messages`.
- Polls every local node's `/inbox`, merges by id, tracks `seenBy` / `agree`
  / `consistent`; `POST /api/signal` sends a GCS signal; SSE `message` events.

**Mesh (backend-network-mesh/src).**
- `--advertise <host>`: a node co-located with its lighthouse would otherwise
  be recorded as `127.0.0.1` and handed out as such to the internet. Honoured
  by lighthouses and peers via `observed()` in `protocol.ts`.
- `--device <name>` in `PeerInfo`.
- **Data channel**: `msg` packets flooded with TTL 4 and dedupe by id; per-node
  inbox; `POST /send`, `GET /inbox?after=`. Forwarding: every same-device
  peer, up to 2 publicly advertised relays, a random sample of other remote
  peers. Kind `gcs.signal` makes each node run matchmaking and store the
  assignment, so every device shows identical actions.
- **Datagram cap** (`MAX_DATAGRAM` 1350 B, `trimToFit`): a 10-node view made
  2.2 KB pings that fragmented and were dropped on the internet path, causing
  a false suspicion every few seconds. Budget per packet: ≤ 8 rumors, then as
  many peer records as fit against the real message shape. (First attempt
  trimmed peers before rumors and starved addresses entirely — members known
  only by rumor had no address. Fixed the same evening.)
- **NAT keepalive** (`keepalive` packet every 8 s to peers on other devices).
- **Indirect probe helpers**: one on the target's own device + one advertised
  relay + random. Needed because two devices behind the same router cannot
  reach each other's public address (no hairpin) — only a relay can.
- Timers overridable by env (`ACK_TIMEOUT_MS` 600, `INDIRECT_TIMEOUT_MS` 1000,
  `SUSPECT_TIMEOUT_MS`, `PROTOCOL_PERIOD_MS`, `KEEPALIVE_MS`).

**Dashboard (frontend-network-mesh).**
- Remote members first-class: header count per device, topology cards (one per
  remote device, name + IP + alive count; expandable to per-node columns),
  links on/off toggle, matrix columns with device/IP sub-labels, "Other
  devices" grouped by device with IP, signals feed with sender IP.
- Two modes, **Command** and **GCS**, switchable in the header (`?mode=gcs`).
  GCS mode sends signals and shows every station's signals with actions taken.
- Display names resolve by service and label duplicates with their device
  ("AEGIS · azure-vm").

**Azure.** Created `mesh-rg` / `mesh-vps` in Japan East (see Current state).
Verified: Mac fleet and VM fleet see each other alive (10 nodes), GCS signals
cross both ways with 5/5 agreement, false-suspicion rate dropped from ~35/min
to single digits once the datagram cap went in (before `mac02` joined).

**Lessons worth remembering.**
- Anything that works on loopback but flaps on the internet: check datagram
  size first. Fragments are dropped silently.
- Two devices behind one router must use LAN addresses for each other; an
  outside lighthouse gives them public addresses that the router won't
  hairpin. See `ADDING-A-DEVICE.md`.
- Docker Desktop's NAT maps each destination separately; the per-pair
  keepalive plus direct-observation address updates is what makes probes
  from the outside land.
- Rebuilding two devices at the same moment makes their views disagree for a
  few seconds; agreement counts below 5/5 during a rebuild are expected.

---

## Verifying a build (checklist)

```sh
cd backend-network-mesh && npm run typecheck
cd ../frontend-network-mesh && npm run typecheck && npm run build
cd .. && docker compose up -d --build && node scripts/smoke.mjs     # PASS
```

With a remote device up, additionally check in the dashboard that its card is
alive, then send a GCS signal from each device and confirm both feeds show it
with the same actions and `5/5 agree`. Suspicion rate sanity check:

```sh
docker compose logs --no-log-prefix --since 60s | grep -c 'refuting rumor'   # ~0 when healthy
```
