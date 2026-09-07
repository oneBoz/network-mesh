# network-mesh: roadmap to a multi-device, internet-wide, secure mesh app

Written 2026-09-07 against the current state of `backend-network-mesh` and
`frontend-network-mesh`. Goal: ship a macOS + Windows app where a device
installs it, pastes an invite, and joins a mesh with devices on *other*
networks (different Wi-Fi, home NAT, mobile hotspot), with the traffic
encrypted and authenticated using well-known open-source components.

---

## 0. Where the repo is today (what already works, what blocks the goal)

**Works and is worth keeping**

- SWIM membership (`src/swim.ts`) is a pure state machine with indirect
  probes, incarnation refutation, resurrection probes, bounded packets.
  This is the core asset; nothing in the plan replaces it.
- Lighthouse join broker (`src/lighthouse.ts`) already records the
  *observed* UDP source address, i.e. the NAT-mapped public address. That is
  exactly the hole-punching primitive you need for internet peers.
- Peer-assisted join, saved peer list, anti-entropy via announce replies.
- Deterministic threat matchmaking (`src/skills.ts`) proves the
  "one entity" property with no leader.
- Control plane + SSE dashboard, all Node built-ins; typechecks on Node 24.

**Blocks the multi-device goal** (each maps to a phase below)

| Gap | Where | Why it matters over the internet |
|---|---|---|
| No encryption, no per-device identity. `MESH_KEY` is one shared HMAC secret; payloads are plaintext. | `src/protocol.ts` | Anyone on-path reads membership and threat traffic; one leaked key = whole mesh. |
| Node query API listens on all interfaces with no auth. `POST /threat` is open. | `src/node.ts` `listen(HTTP_PORT)` | On a VPS or a permissive network anyone can inject threats or read views. |
| Control plane hard-codes `127.0.0.1` for lighthouses and for polling nodes. | `backend/src/procman.ts` `lighthouseAddrs()`, `backend/src/server.ts` `pollNode()` | The dashboard can only see processes it spawned on the same machine. |
| Every lighthouse/node is a child of the dashboard; there is no long-lived per-device agent, no config, no persisted identity. | `backend/src/procman.ts` | A device needs one process that survives reboots and knows who it is. |
| NAT: hole punching works for cone NATs only. Symmetric NAT (many mobile carriers, some corporate) and CGNAT need a relay. | design | Two phones on LTE will never reach each other directly. |
| Timers are compile-time constants tuned for loopback (500 ms ack, 5 s suspect). | `src/node.ts` | Internet RTT + Wi-Fi loss produces false suspicions. |
| Scripts are bash (`scripts/demo.sh`, `pgrep`, `iptables`). | `scripts/` | Windows users cannot run the demo from PowerShell. |
| Types are copy-pasted between the two packages. | `backend/src/types.ts` vs `frontend/src/types.ts` | Drift risk grows as the API grows. |
| No tests, no CI, no git repo, empty top-level README. | root | You cannot refactor the transport safely without a swim.ts test suite. |

---

## 1. Key architectural decision: what carries the encrypted traffic?

The README already says "`MESH_KEY` HMAC ~ Nebula certificates + Noise".
Pick one of three open-source options and build everything else on it.

| Option | Setup for the end user | NAT traversal | Identity / auth | Self-hosted? | Verdict |
|---|---|---|---|---|---|
| **Tailscale** (WireGuard + DERP relays) | Install Tailscale, log in, done. Devices get stable `100.x.y.z` IPs and MagicDNS names. | Solved, incl. symmetric NAT and CGNAT via DERP relays. | Device keys managed by Tailscale; ACLs. | Optional via **Headscale** (open-source control server). | **Use this first.** Fastest path to "two laptops on different Wi-Fi". |
| **Nebula** (Slack's overlay) | Generate a CA, sign a cert per device, distribute config + certs, run a Nebula lighthouse on a VPS. | Hole punching + Nebula relays (needs a public relay host). | Your own CA certs with groups. | Yes, fully. Same lighthouse concept as this project. | **Productized self-hosted version.** More onboarding work. |
| **Plain WireGuard** | Manual key exchange and endpoint config per pair. | None when both sides are NATed. | Static keys. | Yes. | Not "minimal setup". Skip. |
| Native Noise in `node:crypto` (X25519 + ChaCha20-Poly1305, Ed25519 identities) | Nothing extra to install. | You must build relaying yourself. | You build cert/allow-list logic. | Yes. | **Phase 6 stretch goal** once the overlay version is proven. |

Decision for the plan: **run the mesh unchanged over Tailscale for testing,
keep the transport pluggable so Nebula or a native Noise transport can be
swapped in later.** Keep `MESH_KEY` HMAC on as defense in depth; it costs
nothing and catches misconfiguration (its drop reasons are already logged).

Consequence: the lighthouse no longer needs a public IP. It runs on any
device in the tailnet (or a cheap VPS for always-on). Nodes learn each
other's overlay IPs from the lighthouse's observed-source-address logic
exactly as today, because Tailscale presents each peer with a stable IP.

---

## 2. Phased plan

### Phase 0: Repo hygiene and a safety net (1-2 days)

1. `git init` at the root, commit as-is, add a root `README.md` that
   explains the two packages and links to this plan.
2. Convert to an **npm workspaces monorepo**: root `package.json` with
   `workspaces: ["backend-network-mesh", "frontend-network-mesh", "packages/*"]`.
   Move the duplicated API types into `packages/mesh-types` and import them
   from both sides. Delete the "mirror" comments.
3. Replace `scripts/demo.sh` and `threat-demo.sh` with cross-platform Node
   scripts (`scripts/demo.ts`, `scripts/threat-demo.ts`) using
   `child_process` and `fetch`. Keep the bash versions as thin wrappers or
   delete them.
4. Add tests with `node:test` (no new deps):
   - `swim.test.ts`: rumor precedence, refutation bumps incarnation, suspect
     to dead sweep, dead pruning, rumor cap ordering, wildcard address rule.
   - `protocol.test.ts`: HMAC round trip, replay window, mismatch reasons.
   - `skills.test.ts`: matchmaking total order and escalation on removal.
   - An **in-process simulation harness**: N `Membership` instances driven by
     a fake transport with configurable latency and loss, so convergence time
     and false-suspicion rate can be measured deterministically before any
     real network test. `sim/mesh-simulator.tsx` already has this logic in
     React form; extract the pure parts.
5. GitHub Actions matrix (`windows-latest`, `macos-latest`): install,
   typecheck, test, and build the frontend.

Deliverable: green CI on both OSes, zero behavior change.

### Phase 1: Make the mesh process internet-ready (2-4 days)

All in `backend-network-mesh/src`, no new dependencies.

1. **Config over flags.** Add `--config <path>` (JSON) and env overrides for
   every timer: `PROTOCOL_PERIOD_MS`, `ACK_TIMEOUT_MS`, `INDIRECT_TIMEOUT_MS`,
   `SUSPECT_TIMEOUT_MS`, `ANNOUNCE_INTERVAL_MS`, `DEAD_PRUNE_MS`. Ship an
   `internet` profile (ack 1500 ms, indirect 1500 ms, suspect base 10 s,
   announce 20 s) and keep `local` as today.
2. **Bind and advertise addresses.** `--bind <ip>` for the UDP socket and
   `--http-bind <ip>` for the query API, default `127.0.0.1` for HTTP. When
   running over Tailscale, bind UDP to `0.0.0.0` but HTTP to the tailnet IP
   or loopback. Add `--advertise <host:port>` for the always-on VPS case.
3. **Authenticate the query API.** Bearer token from config
   (`--api-token`, auto-generated on first run and stored next to the
   config). `/health` stays open; everything else requires the token. The
   control plane passes it when polling.
4. **Lighthouse hostnames.** `--lighthouses` currently splits on `:` only;
   accept DNS names (MagicDNS names like `lh-vps.tailnet-name.ts.net:5001`)
   and re-resolve on every announce so a VPS re-IP does not strand nodes.
5. **NAT keepalive.** The 1 s SWIM probe already keeps mappings warm on
   busy meshes; add a `keepalive` no-op packet to every known peer every
   25 s when the mesh is small so quiet meshes do not lose mappings.
   (Irrelevant on Tailscale, required for the raw and Nebula paths.)
6. **Rate limiting and packet caps** on inbound: max datagram size, per-source
   token bucket for `join`, drop `ping-req` chains deeper than one hop.
7. **Persistent identity.** Generate a stable node id (or Ed25519 keypair,
   see Phase 6) on first run and store it in the OS app-data directory
   instead of `tmpdir` (`%APPDATA%/network-mesh` on Windows,
   `~/Library/Application Support/network-mesh` on macOS). Move the saved
   peers file there too.
8. Log to a file with rotation in the same directory, in addition to stdout.

Deliverable: `npx tsx src/node.ts --config <app-data>/node.json` runs
unattended on a laptop for a day and rejoins after sleep/wake.

### Phase 2: Secure transport via Tailscale, then verify NAT cases (2-3 days)

1. Install Tailscale on two laptops (one macOS, one Windows) on different
   networks. Optionally stand up **Headscale** on a small VPS if you do not
   want to depend on Tailscale's coordination server.
2. Run a lighthouse on one laptop bound to its tailnet IP; run a node on
   each laptop with `--lighthouses <tailnet-ip>:5001` and the `internet`
   profile. Confirm `/members` converges on both sides and that kill/revive
   escalation still works across the WAN.
3. Add a third always-on lighthouse on the VPS so laptops can join while the
   other is asleep. This is the "3 sites" story from the README made real.
4. Write `docs/tailscale-setup.md`: install, `tailscale up`, find IP,
   firewall rule for UDP 4001/5001 (Windows Defender Firewall
   `New-NetFirewallRule`, macOS prompts on first bind), ACL snippet that
   allows only UDP mesh ports and the HTTP API port between mesh devices.
5. Optional **Nebula track** (only if self-hosting without Headscale is a
   hard requirement): `nebula-cert ca`, per-device certs, one Nebula
   lighthouse on the VPS, then repeat step 2 over the Nebula interface. The
   mesh code needs no change; only the bind IP differs.

Deliverable: two devices on different ISPs see each other within one
suspect window, encrypted end to end, without touching the mesh protocol.

### Phase 3: Per-device agent and a multi-device dashboard (4-6 days)

Today `backend/src/server.ts` is a local process supervisor. Split it into
two roles that can run on the same machine.

1. **`mesh-agent`** (new `backend/src/agent.ts`): a long-lived daemon that
   reads the device config, runs exactly one node (and optionally one
   lighthouse) in-process or as a supervised child, restarts on crash, and
   exposes the control API on loopback with the token. Config lives in the
   app-data directory: `{ id, service, skills, lighthouses, profile,
   apiToken, meshKey }`.
2. **Remote views in the poller.** `pollNode()` currently fetches
   `127.0.0.1:<httpPort>`. Extend it: after polling the local node, walk its
   `/members` view and poll every peer's `info.host:info.httpPort` over the
   overlay (with the token). Mark each `NodeView` as `local` or `remote`, and
   tolerate unreachable remote APIs (their membership status still comes
   from gossip). This gives the convergence matrix across real machines.
3. **Frontend changes**: show device origin (hostname, OS icon) on the
   topology graph; grey out kill/revive for remote nodes (you cannot crash
   another person's process) or route them through that device's agent if
   you want a fleet-wide control plane later. `ProcPanel` becomes "This
   device" plus "Mesh members".
4. **Invite flow**: `mesh-agent invite` prints a compact string or QR
   containing `{ lighthouses[], meshKey, profile }` (plus a Tailscale auth
   key or Headscale pre-auth key if you want fully scripted onboarding).
   `mesh-agent join <invite>` writes the config and starts. This is the
   "minimal setup" promise.
5. Keep the local demo mode (`POST /api/demo`) working; it is the best
   regression test and the best demo.

Deliverable: on each laptop `mesh-agent join <invite>` then open the
dashboard; both dashboards show both devices, the threat ladder works with
the primary on the other machine.

### Phase 4: Desktop packaging for macOS and Windows (3-5 days)

Everything is TypeScript on Node, so **Electron** is the least-friction
container: main process hosts the agent, renderer serves the Vite build,
`electron-builder` produces `.dmg` and NSIS `.exe`. (Tauri is smaller but
needs a Node sidecar binary; revisit only if install size matters.)

1. `apps/desktop`: Electron main starts `agent.ts` in a `utilityProcess`,
   loads the built dashboard from the agent's static route. Tray icon with
   status (joined / degraded / offline), Start at login.
2. First-run wizard: paste invite, pick a service name and skills, done.
3. Installer hooks: Windows NSIS adds the firewall rule for the UDP port;
   macOS prompts naturally. Document that Tailscale must be installed
   separately, or embed an "Install Tailscale" button.
4. Code signing: Apple Developer ID + notarization; Windows Authenticode
   (or accept SmartScreen warnings for internal testing).
5. Auto-update via `electron-updater` from GitHub Releases, built by CI on
   tags.

Alternative for a CLI-only first cut: build single-file binaries with
Node's Single Executable Application feature (`node --experimental-sea-config`)
so testers only download one file. Do this before Electron if you want to
reach multi-device testing sooner.

### Phase 5: Multi-device test campaign (ongoing, start as soon as Phase 2 works)

Progress through these; do not skip a level until the previous one is stable
for an hour.

| Level | Setup | What to measure |
|---|---|---|
| L0 | One laptop, `npm run demo` | Baseline: convergence time, false suspicions per hour (should be 0). |
| L1 | Two laptops, same Wi-Fi, no overlay | Firewall rules correct, LAN reachability, sleep/wake rejoin. |
| L2 | Two laptops, different home networks, over Tailscale | Suspect window vs RTT, refutation success, announce anti-entropy after Wi-Fi switch. |
| L3 | Add a phone hotspot (CGNAT, often symmetric NAT) | Confirms DERP relay path; note the RTT and tune the `internet` profile. |
| L4 | Add the VPS lighthouse, kill the laptop lighthouse | Joins survive; existing traffic unaffected. |
| L5 | Chaos: kill processes, pull cables, change clocks by 2 minutes, put a laptop to sleep for 10 minutes | Replay-window drops are logged not silent; sleep/wake rejoins without a duplicate-id conflict (the 45 s `ID_CONFLICT_MS` guard interacts with sleep). |
| L6 | 5+ devices (mix of macOS/Windows, plus VPS nodes) | Piggyback caps and `MAX_ACK_PEERS` are enough; view sizes stay bounded. |

Instrument for this: add `GET /metrics` (Prometheus text format, built-ins
only) on the node with counters for probes sent/acked, suspicions,
refutations, dropped frames by reason, and a histogram of ack RTT. Scrape
into a Prometheus container on the VPS; the numbers tell you when to change
timers instead of guessing.

Automate with `scripts/wan-test.ts`: run the threat ladder against two
agents by their API URLs and assert identical assignments.

### Phase 6: Stretch goals (after the app is in testers' hands)

1. **Native Noise transport.** Ed25519 identity per device, X25519 key
   agreement, ChaCha20-Poly1305 framing, all from `node:crypto`. Lighthouse
   holds an allow-list of device public keys signed by a mesh CA key that
   the invite carries. Removes the Tailscale/Nebula prerequisite.
2. **Relay role for lighthouses.** For the native path only: lighthouses
   forward encrypted datagrams between peers that fail direct probes, with a
   preference for direct once hole punching succeeds.
3. **Application data channel.** The mesh currently carries membership and
   threat events. Add an encrypted unicast/broadcast message API
   (`POST /send`, SSE `/inbox`) so "devices communicate" means real payloads,
   not only liveness.
4. **Mobile.** Once the native transport exists, the protocol is small enough
   for a React Native or Kotlin/Swift port of `swim.ts`.

---

## 3. Concrete first week

| Day | Do |
|---|---|
| 1 | Phase 0 items 1-3: git init, workspaces, shared types, Node demo scripts. |
| 2 | Phase 0 items 4-5: swim/protocol/skills tests, sim harness, CI. |
| 3 | Phase 1 items 1-3: config file, timer profiles, bind flags, API token. |
| 4 | Phase 1 items 4-8: DNS lighthouses, keepalive, app-data identity, logs. |
| 5 | Phase 2: Tailscale on two laptops, first cross-network join, write setup doc. |

At the end of the week you can run the L2 test with the existing dashboard
on one laptop pointed at its local node, which already sees the remote
device through gossip. Phase 3 then makes the dashboard multi-device.

---

## 4. Risks and how the plan handles them

- **Symmetric NAT / CGNAT** breaks direct UDP. Handled by choosing an
  overlay with relays (Tailscale DERP or Nebula relays) before touching
  NAT code yourself.
- **Laptop sleep.** A node that sleeps 10 minutes is convicted dead, pruned
  after 30 s, and re-registers on wake. The lighthouse id-conflict guard
  only bites if the address changed within 45 s, so this is fine, but test
  it explicitly (L5).
- **Clock skew** kills signed frames after 60 s. Keep NTP on, log the drop
  reason (already done), and consider widening the window to 5 minutes for
  the `internet` profile.
- **Exposed query API.** Fixed by loopback default + bearer token in
  Phase 1 before any machine is put on a public network.
- **Two packages drifting.** Fixed by the shared types workspace in Phase 0.
- **Windows-only surprises**: Hyper-V port exclusions (already probed by the
  control plane), Defender Firewall inbound UDP, path separators, no bash.
  CI on `windows-latest` from day 2 catches these early.
