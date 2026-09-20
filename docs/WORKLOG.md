# Work log

A running record of what was built, why, and where things stand, so the
project can be picked up from any machine after a `git pull`. Newest at the
bottom of each section. Update this file whenever something non-obvious
changes (a decision, a bug found in the field, a machine's configuration).

Companion documents: [`ADDING-A-DEVICE.md`](ADDING-A-DEVICE.md) for onboarding
a machine, [`../PLAN.md`](../PLAN.md) for the roadmap, the root
[`README.md`](../README.md) for running the demo.

---

## Current state (2026-09-15, morning)

### Machines in the mesh

| Device name | What | Where | Runs |
|---|---|---|---|
| `dingyi-mac` | Dingyi's Mac, home Wi-Fi, LAN `192.168.0.8` on 2026-09-15 (DHCP — it was `.13` the day before; check `ipconfig getifaddr en0`), public `116.88.197.32` | Singapore | Full dashboard via `docker compose up`, `EXTRA_LIGHTHOUSES=<mac02 LAN>:5001,23.100.103.160:5001` |
| `mac02` | Second Mac on the **same router** as `dingyi-mac` | Singapore | Full dashboard on the G1 build; was **off** on 2026-09-15 morning (its nodes show dead). Rebuild on the current code before the demo |
| `azure-vm` | Azure VM `mesh-vps`, Standard_B2pls_v2 (2 vCPU, 4 GB, arm64), Ubuntu 24.04, resource group `mesh-rg`, region Japan East | Tokyo | Full dashboard with host networking (`docker-compose.host.yml`), `ADVERTISE=23.100.103.160`; its lighthouse on UDP 5001 is the one every other device joins. On the G4 build as of 2026-09-15 |

Judging-day procedure: [DEMO.md](DEMO.md).

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
`PUBLIC_IP`, `MESH_KEY` (the private key, see below), `DEVICE_NAME=azure-vm`.

Start / update the VM site (from the repo root on any machine that can SSH in):

```sh
rsync -az --exclude node_modules --exclude .git --exclude dist --exclude .env --exclude .DS_Store ./ azureuser@23.100.103.160:~/network-mesh/
ssh azureuser@23.100.103.160 'cd ~/network-mesh && set -a && . ./.env && set +a && ADVERTISE=23.100.103.160 DEVICE_NAME=azure-vm sudo -E docker compose -p mesh-dashboard -f docker-compose.yml -f docker-compose.host.yml up -d --build && curl -s -X POST 127.0.0.1:7070/api/demo'
```

Its dashboard is loopback-only; open it with `ssh -L 7070:127.0.0.1:7070 azureuser@23.100.103.160` then http://localhost:7070.

Cost control: `az vm deallocate -g mesh-rg -n mesh-vps` between sessions,
`az vm start -g mesh-rg -n mesh-vps` before (IP is static). Subscription is
"Azure for Students"; allowed regions are only indiasouthcentral, japaneast,
centralindia, koreacentral, malaysiawest, and only arm64 B-series had capacity.

### Shared secret (= access key to the mesh)

Every packet is encrypted and authenticated with a key derived from
`MESH_KEY` (AES-256-GCM, since 2026-09-15); the Azure lighthouse and every
node drop anything under a different key and log the rejected source.
The key is **not in the repo**: it lives only in each device's `.env` (Mac,
mac02, and `~/network-mesh/.env` on the VM). Rotated on 2026-09-14 evening
to a random 64-hex-char value generated with `openssl rand -hex 32`; the old
`hackathon-demo-key` (which had been committed) no longer works. To get the
key onto a new device, copy it from an existing device's `.env` out-of-band.
Rotate by changing it on every device and restarting; the VPS compose files
refuse to start without one (`REQUIRE_MESH_KEY`).

### Known open items

- `mac02` must be rebuilt on the current code and both Macs should list each
  other's **LAN** lighthouse (see the same-router note below). Until then it
  is either absent or a source of false suspicions on the Mac side.
- One shared key, no per-device identity: any key holder can claim any
  device name; a leaked key exposes the whole mesh. Phase 6 (Noise/Ed25519).
- CI (Phase 0): 22 `node:test` tests exist (`npm test`) but nothing runs them
  automatically yet.
- Fixed 2026-09-15: escalation on transient convictions (dead-grace) and the
  unauthenticated node query API (bearer token) — see the hardening entry.

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

**Access control.** Public lighthouses now require `MESH_KEY`
(`REQUIRE_MESH_KEY=1` in the VPS compose files, which also fail to start with
an empty key); rejected packets are logged per source address with a running
count. Key rotated and removed from the repo.

**Mobile / hotspot robustness.** `MESH_PROFILE` presets (local / internet /
mobile); join/announce carry the incarnation so a lighthouse accepts a node
that moved to a new address at once (and nodes re-announce right after
refuting a suspicion); relay-aware probing remembers peers reachable only
via a relay and probes them through helpers first, retrying direct every
30 s; `/members` exposes `paths`, the dashboard shows "via relay".

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

### 2026-09-14 (late) — Planned: map, trajectories, engagement lifecycle

Decided and written up as `PLAN.md` §5: simulated tracks from the GCS UI,
Command-owned location table (persisted, broadcast), assigned-GCS-only
neutralise with automatic escalation, Leaflet + OSM tiles with a bundled
Singapore GeoJSON fallback. Open questions closed: 1 Hz updates, Command
places named defended assets too, at most 3 concurrent tracks, EMP stays an
area event. Build order: locations → lifecycle reducer (with tests) → track
stream + map → offline fallback and scenarios.

### 2026-09-14 (late) — G1 built: location table + map

- `backend/src/geo.ts`: persisted, versioned `GeoStore` (atomic file replace
  under `DATA_DIR`; Docker volume `mesh-data` mounted at `/data`, pre-created
  owned by `node` in the Dockerfile).
- Control plane: `GET/PUT/DELETE /api/geo`, broadcast as `geo.locations` after
  every edit and every 60 s, `geo.locations.request` every 15 s while empty,
  adoption by version from other devices, SSE `geo` event, `MeshState.geo`.
- Frontend: `MapPanel.tsx` (Leaflet 1.9.4 bundled via npm, OSM tiles darkened
  to the theme, divIcon markers coloured by consensus status, assets as
  diamonds). Command: place mode (pick item → click map, drag to move, remove
  assets, new-asset input). GCS: read-only map above the feed. "tiles offline"
  badge when the first tile fails — the bundled GeoJSON fallback is G4.
- Verified: three entries placed on the Mac reached the VM's table (v3) within
  2 s; the table survived a container restart via the volume.

### 2026-09-15 — Lighthouse mode + spacious layout

- `lighthouse.ts --http <port>`: loopback-only registry API (`/registry`,
  `/health`) with joins/rejected counters; the control plane allocates 9001+
  for every lighthouse it spawns and polls them into `MeshState.lighthouses`.
- Third dashboard mode **Lighthouse** (`LighthouseView.tsx`): summary, one
  card per lighthouse with its registry table, filtered and colour-coded log.
- Control plane replays the last 300 log lines to each new SSE client.
- Layout: the page scrolls instead of forcing everything into 100vh — sticky
  header, two-column grid (3:2) with natural panel heights, no list caps, one
  column under 1150 px. Topology height follows its viewBox.

### 2026-09-15 — G3 built: engagement lifecycle

- `src/engagement.ts`: pure reducer (detected → engaging → neutralised | lost;
  escalation on dead/timeout/handover; responsible-device authorisation with
  Command override; out-of-order queueing; position updates for G2).
  `test/engagement.test.ts`: 10 tests incl. determinism across interleavings.
  `npm test` in backend-network-mesh.
- Node: applies lifecycle messages at ingest, ticks every protocol period,
  `GET /tracks`. Control plane: merges `/tracks` across local nodes with an
  agreement count into `MeshState.tracks`; `POST /api/tracks/<id>/<action>`.
- Dashboard: lifecycle badge + ENGAGE / NEUTRALISED / hand over controls on
  signal rows and the GCS engagement card (enabled only when this device is
  responsible; Command gets a logged override), Engagement timeline panel,
  topology ring cleared on neutralise.
- Verified Mac ↔ Azure: unauthorised neutralise rejected, authorised accepted
  (5/5 agree both sides), killing the responsible node escalated to the Mac
  in ~10 s, handover moved responsibility across devices.

### 2026-09-15 — G2 built: simulated tracks + trajectories

- `backend/src/simulator.ts`: server-side scenario driver (≤3 live per device,
  1 Hz `track.update`, per-threat lateral pattern, stops when the mesh says the
  track is no longer live, `track.impact` on arrival, `track.lost` on cancel).
  `POST /api/sim/tracks`, `DELETE /api/sim/tracks/<id>`, `MeshState.sims`.
- Reducer: `impact` terminal state (origin-only), `target` field, terminal
  states refuse further actions (11 tests).
- Map: trajectory layer (polyline, pulsing heading glyph, label with state/ETA/
  target/responsible, dashed line to target, ✔/✖ heads, CSS-transitioned
  motion), origin picking mode. GCS: scenario launcher + running sims list
  with cancel. Impact in badges and timeline; topology ring cleared on impact.

### 2026-09-15 — G4 built: offline basemap, scenarios, demo runbook

- Offline basemap: `scripts/build-basemap.mjs` simplifies the data.gov.sg
  planning-area polygons (Douglas-Peucker 0.0003°, 41k → 3k vertices) into
  `frontend-network-mesh/src/basemap/singapore.geo.json` (58 KB, committed,
  Singapore Open Data Licence). `MapPanel` loads it as a lazy chunk into a
  pane *under* the tiles when a tile fails (or on the 🗺 offline switch,
  remembered in localStorage), so patchy tiles reveal the drawn island and
  fully offline shows the whole map with the same markers/trajectories.
  The map wrapper div is now React-owned and Leaflet gets an inner div —
  toggling `picking` used to overwrite Leaflet's own classes.
- Scenarios: `backend/src/scenarios.ts` — four scripted attacks (launches
  relative to one target: delay, threat, bearing, range, ETA) run by a
  `ScenarioRunner` on the existing simulator; `GET /api/sim/scenarios`,
  `POST /api/sim/scenarios/<id>`; stop-all drops pending launches. Demo layout
  seed: six real assets + slots for unplaced devices, `POST /api/geo/seed`
  (one version bump via `GeoStore.setMany`), button in the Command map panel.
  GCS launcher gained a scenario select + run button.
- Tests: 15 (`npm test`) — added late-joiner replay equivalence for the
  reducer, `destination()` inverse check, scenario shape constraints, seed
  idempotence. `scripts/scenario.mjs` runs a scenario against a live
  dashboard and follows every transition until the tracks end.
- Late joiners: a device whose fleet booted *after* a launch received every
  `track.update` but never the `track.detected`, so it showed no track. The
  simulator now re-floods the original detection (same id) every 15 s while
  live (`POST /send {resend: <id>}` on any node holding it); nodes with the
  track drop it (`ingestMessage` checks `engagement.tracks`), late joiners
  create it and replay their queued updates. Stands in for `track.snapshot`.
- Docs: `docs/DEMO.md` (judge runbook), README sections, backend API list.
- `scripts/smoke.mjs` now requires identical alive sets for 3 consecutive
  polls before firing: right after a boot, views of remote peers still flap.

### 2026-09-15 — Encryption: AES-256-GCM frames replace HMAC signing

- `src/protocol.ts`: every datagram is now `0x02 | nonce(12) | AES-256-GCM(
  "<ts>\n<json>") | tag(16)`, key = HKDF-SHA256(MESH_KEY, "network-mesh",
  "frame/aes-256-gcm/v2"); version byte is authenticated as AAD; 60 s replay
  window kept. 29 bytes overhead (HMAC framing was ~80), so `MAX_DATAGRAM`
  is unchanged. `encodeWith/decodeWith/deriveKey` exported for tests;
  `test/protocol.test.ts` (6 tests: round trip, nonce uniqueness, payload
  hidden, wrong key / bit flip / truncation, replay, mixed configs, old HMAC
  frame reported as "older build", max-size datagram).
- Drop reasons renamed: `authentication failed — MESH_KEY mismatch, or the
  packet was altered`, `plaintext packet on an encrypted mesh`, `unknown
  frame version … older build`. Lighthouse/node banners and the Lighthouse
  mode badge say ENCRYPTED / PLAINTEXT.
- **Not backward compatible**: a device on a pre-encryption build is rejected
  with `unknown frame version`. Rebuild every device (Mac, VM done; mac02
  pending).
- Verified: wrong-key intruder rejected and counted on lh-5001
  (`authentication failed`), zero peers learned; smoke PASS on both devices;
  cross-device scenario streamed encrypted with 5/5 agreement on both sides.
- When two devices are rebuilt within a minute of each other their fleets
  join while the other side is still down and only merge on the next
  announce cycles (the lighthouse answers announces with a peer list) — allow
  ~2 minutes before judging agreement, or rebuild one device at a time.

### 2026-09-15 — Pre-judging hardening: dead-grace escalation, node API token

- `engagement.ts`: `EngagementContext.deadFor(node)` + `deadGraceMs`; `tick()`
  escalates on a dead responsible node only once the conviction has held for
  the grace window. `node.ts` supplies `membership.entry(id).since` and the
  profile's (size-scaled) suspect timeout as the grace, so a false conviction
  during churn — refuted within one suspect window — no longer moves
  responsibility. Closes the "escalation on transient convictions" item.
  Test: flap refuted → no escalation; held for the window → escalates (22).
- `procman.ts` mints `NODE_API_TOKEN` (random per start unless set) and passes
  it to every child; `node.ts` returns 401 on every query-API request without
  `Authorization: Bearer <token>` (except `/health`); `server.ts` sends it
  via `nodeFetch()`. Nodes started by hand without the variable stay open.

### 2026-09-15 — Judging-day tooling and a network finding

- `scripts/preflight.mjs [--expect dev1,dev2] [--drill]`: GO / WARN / NO-GO
  table — dashboard, fleet, encryption, stable convergence, each expected
  remote device (alive count, address, direct/relay), map layout, tile
  reachability, a timed cross-device signal (3 attempts; a retry is WARN),
  and with `--drill` the runbook's kill/revive step with timings. Wired into
  DEMO.md step 2. First run: kill → first suspicion 2.3 s, dead on all peers
  13.4 s (15-member mesh: suspect window scales with size), revive → alive
  1.8 s.
- `backend-network-mesh/scripts/find-lighthouses.ts <cidr|ip…>`: sends an
  encrypted join to every host and lists lighthouses that answer — the way
  to fill `EXTRA_LIGHTHOUSES` with a LAN address.
- Finding: on this home Wi-Fi the two Macs cannot reach each other on the
  LAN at all (no lighthouse answers, neighbours do not even answer ping —
  client isolation), so they talk through the router's public address. That
  hairpin path is lossy: ~70 suspect transitions per minute across the two
  Macs, and a signal can land at 1/5 agreement. Tried `MESH_PROFILE=internet`
  on dingyi-mac: no change (84 suspicions/min settled) — the hairpin drops
  packets, wider timers cannot fix loss; reverted to `local`. The relay path
  via the VM keeps mac02 5/5 alive. At the venue, a wired switch removes the
  problem — run `find-lighthouses.ts` there and use LAN addresses. Preflight
  on the settled mesh: GO, signal 5/5 in 1.0 s across all three devices.
- Cold rehearsal from a fresh clone with `.env.example`: PASS (smoke,
  scenario, seed, token gate).

### 2026-09-17 — Performance pass: compiled children, state patches, in-place map updates

Measured first, on the Mac's Docker container with the demo fleet idle: the
container sat at ~790 MB — nine `node --import tsx` processes at 106-113 MB
each plus a 21 MB esbuild service process per Node process — and `/api/state`
was 63 KB (`messages` alone 32 KB), re-sent to every dashboard tab once a
second whether or not anything had changed. Each process took ~330 ms and
~80 MB just to load tsx before running a line of mesh code.

What changed:

- **Compiled children.** `npm run build` (`tsconfig.build.json`) emits `dist/`;
  Docker runs `node dist/backend/src/server.js`, and procman spawns children
  the same way as its parent runs (`COMPILED` in procman.ts: plain
  `node dist/src/<entry>.js` when compiled, tsx under `npm run dev`). The
  runtime image ships no `node_modules`. `npm start` runs the compiled build
  natively. `docker-compose.remote.yml` commands updated to match.
- **Control plane.** The four poll phases run concurrently; the poll re-arms
  after it completes instead of `setInterval` (a stalled node can no longer
  make rounds overlap or publish out of order). `state` SSE events are patches
  of the slices whose JSON changed — nothing at all while idle — with the full
  snapshot on connect. `messages` left the state push: each message is its own
  `message` event, re-sent when its agreement changes (housekeeping
  `geo.locations` traffic stays out of it). Hashed `/assets/*` get
  `cache-control: immutable`.
- **Nodes.** `/members` answers compact JSON (it was pretty-printed for a 1 Hz
  machine consumer); `/tracks` omits the trajectory of tracks finished more
  than 120 s ago (the map stops drawing them at 90 s); `trimToFit` sizes a
  packet from the JSON length plus the frame constant (`wireSize`) instead of
  encrypting it once per dropped item; `Membership.peer()`/`status()` give O(1)
  lookups where the lifecycle context and the path summary scanned copies of
  the peer list; rumor send counters are bumped only for rumors that actually
  left the node (`noteGossiped`); `sample()` is a partial Fisher-Yates.
- **Lighthouse registry** reports `startedAt` and `lastSeen` instead of
  `uptimeMs`/`ageMs`, so an idle registry does not change every second; the
  Lighthouse view keeps its own one-second clock for "ago" and uptime.
- **Frontend.** State patches merge over the previous snapshot, so untouched
  slices keep their identity. MapPanel keeps its markers and track layers in a
  map and updates them in place — the head marker's element now survives each
  1 Hz update, which is what the 1 s CSS transition needed to make targets
  glide instead of jump. EventLog keys rows by a monotonic id (index keys
  shifted every flush) and is memoised. TopologyGraph memoises layout, gossip
  web and per-node beliefs on the slices it reads, so a drag only moves
  positions.

After, same fleet, same machine: container ~285 MB (backend 105 MB, each
child 74-78 MB, no esbuild processes); image 233 MB instead of 343 MB; on
**Boot demo** all eight children log "up" within ~100 ms of being spawned
(a single compiled process: 150-280 ms inside the container, 130-150 ms
natively, against 360-540 ms via tsx); `/api/state` 26 KB; an idle SSE client
receives a `state` patch only when a view or track actually changes (observed:
a new remote peer, a relay-path change), typically under 20 KB. `npm test`
23/23, `smoke.mjs` PASS with the Azure peers still on the previous build (the
wire protocol is unchanged, so mixed builds interoperate).

Field note: the very first boot after the first `--build` on the Mac showed a
one-off ~9 s spawn-to-"up" gap for all eight children (cold image layers in
the Docker Desktop VM, most likely); the next rebuild's first boot took
93 ms. Boot the fleet once before the demo anyway.

### 2026-09-19 — Dashboard redesign: situation / act / diagnose, WCAG, HIG

A review of the dashboard against WCAG 2.2 and Apple's HIG (headless-Chrome
captures of all three modes, contrast measured per token) found: `--faint` at
1.9:1, `--dead` text at 4.4:1, control borders at 1.2:1, no visible focus, `×`
buttons without names, twelve unlabelled inputs and selects, 28 hover-only
tooltips, 9.5-11 px labels, colour-only belief on the topology, animations
ignoring Reduce Motion, emoji as icons, destructive actions indistinguishable
at rest, and every panel at equal weight so the timeline sat below the fold.
A wireframe was vetted first (decisions: map first, a confirmation sheet for
Stop all, keep the name mesh-ts, dark only, diagnostics collapsed by default).

Implemented in `frontend-network-mesh/src`:

- **Tokens** (`styles.css`): new palette, every text role ≥ 6:1 on the panel,
  control borders 3.1:1, `--threat` magenta so threats and tracks stop sharing
  amber with suspect; system font stack, `ui-monospace`, tabular figures,
  12 px floor (11 px only in monospace), 8-pt spacing, global
  `:focus-visible` ring, `prefers-reduced-motion` kills every animation,
  44 px controls when the pointer is coarse.
- **Primitives** (`ui.tsx`): `Pill`, `StatusGlyph` (shape + word before
  colour), `ThreatIcon` (SVG, `aria-hidden`), `Field` (label wraps control),
  `Disclosure` (remembered per browser), `Segmented`, `MoreMenu` (native
  `details`, Escape / outside click), `ConfirmSheet` (dialog, focus to Cancel,
  Escape / backdrop cancel).
- **Command** (`App.tsx`, `StatusStrip.tsx`, `Situation.tsx`): status strip;
  Situation panel with Map | Topology (both stay mounted; Leaflet
  `invalidateSize` on return) and the timeline beside it; Fleet / Inject a
  threat / GCS signals row; Convergence matrix, Resolve and Live log as
  disclosures, closed by default. Stop all… and Remove from fleet… confirm.
  Kill is red at rest and immediate; Revive is the primary on a down node.
- **Topology**: glyphs are focusable buttons with labels; arrows nudge
  (Shift ×2.5), Enter/Space clicks; belief by shape; sentence-case tools.
- **GCS**: station strip (station name is a labelled field), threat buttons
  with drawn icons, Latest engagement card with Engage / Neutralised / Hand
  over directly beneath (disabled with the reason when not responsible),
  labelled launcher form, own-signals outlined in the accent.
- **Lighthouse**: four tiles (rejected turns red when non-zero), one registry
  table by node with a per-lighthouse ✓ column (by-lighthouse cards kept
  behind a toggle), filterable log (All / Rejections / Moves).
- **Map**: toolbar with state pills, shape-coded legend, labelled new-asset
  field, named remove buttons, `role="application"` on the map.
- **Log**: `role="log"` with `aria-live="off"`, a "paused while you read"
  pill and Jump to latest; matrix has a caption and row/column scope.

Not changed: wire protocol, control-plane API, any script. Every existing
feature and endpoint is reachable from the new layout.

### 2026-09-19 — Segment 6 video: live 12 s self-healing clip

- The storyboard gives the kill → suspect → dead → rejoin → rediscover arc
  12 s (1:48–2:00). At default timers it takes 17–20 s live: the suspect →
  dead window in `node.ts` scales with membership and doubles to 10 s once
  the Azure and vk-mac fleets are joined (~12 members).
- `docker-compose.yml` now forwards `PROTOCOL_PERIOD_MS`, `ACK_TIMEOUT_MS`,
  `INDIRECT_TIMEOUT_MS`, `SUSPECT_TIMEOUT_MS` (empty = profile default) so a
  recording can shorten the local fleet's timers without touching code.
- `docs/video/segment6/record.mjs` drives a headless Chrome tab over CDP with a
  screencast and a drawn cursor that clicks Kill and Revive in the Fleet
  panel; it waits on the dashboard's consensus rule at each beat instead of
  fixed sleeps. `encode.mjs` turns the frames into an mp4 of exactly the
  target length (uniform speed-up only if the take runs long). The Playwright
  ffmpeg cannot write H.264, so encoding uses `ffmpeg-static` or Homebrew.
- Take with `PROTOCOL_PERIOD_MS=500 SUSPECT_TIMEOUT_MS=1500`: kill → suspect
  3.7 s, suspect → dead 3.1 s, revive → alive 1.8 s, 16.7 s total, played at
  1.43× → `segment6-self-healing.mp4` (12.0 s, 415 KB). Frame is the dashboard
  at 80 % zoom so strip, topology and Fleet rows all fit in 1080 lines. The
  guide lists both compressions for the caption.
- Local fleet restored to default timers afterwards; preflight GO. The VM got
  the compose change and docs by rsync only (no restart; the new variables are
  no-ops until set).

### 2026-09-19 — Second demo clip: mock swarm engaged and neutralised

- A swarm's responsible GCS is MAELSTROM on azure-vm (the chain sorts that
  device first), so this Mac's console only offers a Command override. The
  clip therefore records the VM's GCS console through an SSH tunnel while the
  Mac's GCS launches the simulated swarm: `docs/video/segment6/record-swarm.mjs`
  on a new shared `lib.mjs` (headless tab, screencast, drawn cursor, button
  clicks, poll-until helpers).
- Two throwaway takes taught the framing: an origin outside the default map
  view draws nothing, and the GCS console fits 1080 lines at 1:1, so it is
  recorded at 1920 × 1080 unscaled. Final origin is in the Strait south-west
  of Changi with a 25 s time to impact.
- Take at default timers: report → matchmade on the VM 1.1 s, Engage click →
  engaging 1.3 s, Neutralised click → neutralised 0.6 s, 5/5 agree on every
  device; 14.1 s played at 1.18× → `swarm-engage-neutralise.mp4` (12.0 s).
- `encode.mjs` now ends a take at the recorder's "end" mark rather than the
  last frame, since the screencast only emits on repaint.
- Both fleets were restarted three times for clean track histories; preflight
  rerun afterwards. The offline second Mac resurfaced from a lighthouse
  registry in the final take (visible as `mac02 0/2`).

### 2026-09-19 — Closing sequence assembled: both clips, captions, end card

- `docs/video/segment6/build-closing.mjs` composites the self-healing and
  swarm clips into `closing-sequence.mp4` (25.2 s): 0.3 s dissolve at 11.7 s,
  the swarm's last frame held 1.5 s, timed caption overlays with alpha fades,
  an amber focus ring on AEGIS, the end card fading in over the dimmed final
  frame, and a fade to black. One ffmpeg filter graph; no editor needed.
- Captions and the end card live in `overlays.html` (dashboard tokens, system
  type); each layer is rendered to a transparent PNG by headless Chrome via a
  new `png()`/`close()` in `lib.mjs`. Self-healing captions sit in the empty
  timeline panel because the Fleet rows at the bottom carry the clicks; swarm
  captions sit bottom-left where the GCS view draws nothing.
- The end card's credits block is empty until `CREDITS` in `overlays.html` is
  filled in (no team or mentor names exist in the repo). `endcard.png` is the
  card alone.

### 2026-09-20 — Membership: the dead stay forgotten, registries stay complete

Found while looking at why an offline device resurfaced in the final video
take. Reproduced on loopback (lighthouse + 3 nodes, one killed): the corpse was
never forgotten. Every 30 s the survivors pruned it and re-learned it within
2 ms (`unknown → alive`, `alive → dead`), restarting the prune timer — for as
long as the run lasted. Three causes, all fixed in `swim.ts` / `node.ts`:

- **Rumor ping-pong.** A rumor about an unknown id created a view entry, so
  a neighbour that had not pruned yet re-created the corpse (fresh timestamp)
  in a node that had, which gossiped it back after the neighbour pruned. Now a
  rumor about an unknown member is ignored (memberlist's rule): members enter
  the view only with an address, via `upsertPeer`.
- **Dead addresses in the gossip.** Piggybacked peer lists, join answers and
  NAT keepalives included dead peers; a pruned node took the record as a new
  "alive" member, probed it, re-convicted it. They now carry live peers only.
- **Stale lighthouse registries.** A lighthouse hands out a node for
  `STALE_MS` (2 min) after its last announce, and every announce reply is
  absorbed as a peer list — the phantom seen in the video (`mac02 0/2`).
  Pruned ids are now **tombstoned** (`FORGET_MS`, 10 min): hearsay about one
  returns `"held"` from `upsertPeer` and the node runs a `verify()` probe of
  the offered address instead (direct, then through helpers, rate limited to
  one per id per 10 s). Only first-hand evidence re-admits: a packet from the
  node itself, or an ack — direct or relayed — to our own probe. A restarted
  or reconnected device is back within a probe; a dead one never flickers.
  `ping-req` no longer enters the target into the view either (the requester
  asks because its own probe failed). `/members` gained `forgotten`.
- **Announces go to every lighthouse**, not a random one. With the demo's 4
  lighthouses (3 local + Azure) each registry heard from a node with
  probability 1/4 per 30 s, so a live node was missing from any given registry
  (3/4)^4 ≈ 32 % of the time (dashboard registry counts flickered, and a
  cross-site merge after a partition waited ~2 min on average for the right
  lighthouse to be picked). Now one interval.

New `test/swim.test.ts` (5 tests: unknown rumors ignored, upsert results,
prune → tombstone → held/re-admit, tombstone expiry, two-node convergence).
Loopback re-run after the fix (kill at +0, lighthouse still listing the node
for the whole run): dead at +10 s, pruned at +41 s, `ABSENT tombstoned` on
both survivors from then on with no further transitions; the node restarted at
+82 s was alive on both by +84 s. Each survivor logged exactly one
alive → suspect → dead cycle and one `unknown → alive` on the restart. Not backward compatible in behaviour only (wire format unchanged): a
device on an older build still re-seeds phantoms into its own view, so rebuild
every device.

Deployed 2026-09-20 09:00 SGT on the Mac (`docker compose up -d --build`) and
the Azure VM (rsync + host-network `up -d --build`); both fleets rebooted.
Smoke PASS from the Mac with three devices in the mesh (dingyi-mac, azure-vm,
vk-mac), `5/5` on the signal and the track. The Mac's three registries now
each list all five local nodes (before: 4, 2, 3). The `mac02` phantoms that
had been showing as dead remotes for a day are gone. One boot-time false
conviction of `wisl-azure-vm` (VM fleet mid-boot) was refuted within 1.4 s,
the known transient. `vk-mac` still runs the previous build: its nodes announce
to one random lighthouse, so it is intermittently missing from the VM's public
registry until it rebuilds. README gained a step-by-step Apple Silicon setup
and an "Updating a device to a new build" section with the Mac and VM commands.

## Verifying a build (checklist)

```sh
cd backend-network-mesh && npm run typecheck && npm test && npm run build
cd ../frontend-network-mesh && npm run typecheck && npm run build
cd .. && docker compose up -d --build && node scripts/smoke.mjs     # PASS
node scripts/scenario.mjs cruise-north                              # PASS (ends in IMPACT unless neutralised)
```

With a remote device up, additionally check in the dashboard that its card is
alive, then send a GCS signal from each device and confirm both feeds show it
with the same actions and `5/5 agree`. Suspicion rate sanity check:

```sh
docker compose logs --no-log-prefix --since 60s | grep -c 'refuting rumor'   # ~0 when healthy
```
