# Judge demo runbook

Seven minutes, two devices, one story: *a defence mesh that keeps deciding
correctly while things break.* Every step below says what to click, what to
say, and what the judges should see. Terminal equivalents are at the end for
when a browser misbehaves.

Addresses, keys and the current state of each machine are in
[WORKLOG.md](WORKLOG.md). Never show or paste `MESH_KEY`.

## Before the judges arrive (30 min)

1. **Remote device up.** Start the VM, sync the latest code, rebuild:

   ```sh
   az vm start -g mesh-rg -n mesh-vps
   rsync -az --exclude node_modules --exclude .git --exclude dist --exclude .env ./ azureuser@<vm-ip>:~/network-mesh/
   ssh -i ~/.ssh/id_rsa azureuser@<vm-ip> 'cd ~/network-mesh && sudo -E docker compose -p mesh-dashboard -f docker-compose.yml -f docker-compose.host.yml up -d --build'
   ```

2. **This device up.** `docker compose up -d --build`, then

   ```sh
   node scripts/preflight.mjs --expect azure-vm,mac02 --drill
   ```

   must end with `GO`. It checks encryption, convergence, every expected
   remote device, the map, tile reachability, times a cross-device signal to
   5/5 agreement, and with `--drill` rehearses the kill/revive step and
   prints how long suspect → dead and the refutation took. Fix anything
   marked `NO-GO`; `WARN` lines are things to know, not blockers.

3. **Tabs.** Open, in this order, on the presenting Mac:
   - `http://localhost:7070` — **Command**
   - `http://localhost:7070/?mode=gcs` — **GCS** on this device
   - `ssh -i ~/.ssh/id_rsa -N -L 7071:127.0.0.1:7070 azureuser@<vm-ip>` in a
     terminal, then `http://localhost:7071/?mode=gcs` — **GCS on the VM**
     (its dashboard is loopback-only; the tunnel is the only way in)
   - `http://localhost:7070/?mode=lighthouse` — **Lighthouse**

4. **Map ready.** In Command: **Boot demo** if the fleet is not running, then in
   the map panel **⊕ seed Singapore demo layout**. Six assets and both devices
   appear; drag the VM's marker if you want it somewhere specific. Check the
   map header says nothing about tiles (online) and press **⤢ fit**.

5. **Sanity, by eye.** The remote device's card in Command is green
   (`5/5 alive`). Send one `swarm` from the VM's GCS tab: it must appear in
   this device's feed within two seconds with `5/5 agree`. Neutralise it from
   whichever device is responsible so the map is clean.

If step 2 says `NO-GO` or step 5 fails, see *If something goes wrong* below
before continuing. Two Macs on one router must list each other's **LAN**
address in `EXTRA_LIGHTHOUSES` (DHCP can change it — check with
`ipconfig getifaddr en0`; `backend-network-mesh/scripts/find-lighthouses.ts`
scans the LAN for lighthouses that answer to your key).

## The seven minutes

Times are cumulative. Say the words in *italics*; do the actions in **bold**.

### 0:00 — What you are looking at (Command tab)

*This is one container: three lighthouses and five defence-system nodes, each
a separate process speaking SWIM gossip over UDP. Nothing is central — the
lighthouses only introduce peers, they are never in the data path.*

**Point at the topology**: five nodes, three lighthouses, all green. **Point
at the convergence matrix**: every node's view of every other node — all
green means they agree. **Point at the remote device card**: *that device is
in Japan, behind a NAT, joined through a public lighthouse — its five nodes
are members of the same mesh.*

### 1:00 — Self-healing

**Kill `aegis-<this device>`** in the fleet panel. Watch the log: `alive → suspect`
within a couple of seconds, `suspect → dead` 5–15 s later on every node
independently (the suspect window grows with the number of members — with
three devices' fleets it is about 13 s; the preflight drill prints the exact
figure for today's mesh). Revival is fast: under two seconds.

*No coordinator noticed this. Each node probed, asked others to probe, and
convicted — the SWIM protocol. Now watch the decision change.*

**Inject `missile`.** Primary is now **smartfalcon** on the topology ring;
before, it was aegis. **Revive aegis**: the log shows
`refuting rumor that I am dead — incarnation now 1`, and the next missile
goes back to aegis.

### 2:00 — Two devices, one answer (GCS tabs)

**Switch to the VM's GCS tab** (port 7071). **Report `swarm`.** **Switch to this
device's Command tab**: the signal is in the feed with the same chain and
`5/5 agree`.

*The station in Japan sent one message. Every node here ran the same
deterministic matchmaking over its own view of the mesh and reached the same
assignment — and the dashboard counts how many agreed, so disagreement would
be visible, not hidden. The device that runs the assigned system is now
responsible for this target; only it can press NEUTRALISED.*

**On the responsible device's GCS tab, press ENGAGE, then NEUTRALISED.** The
badge flips everywhere. If time allows, try NEUTRALISED from the *other*
device first: it is recorded as **rejected** and shown as such.

### 3:00 — Trajectories on the map (this device's GCS tab)

**Pick a target** (Changi Airbase), **choose scenario `saturation`, press
▶ run scenario.** Over 20 seconds a missile, an aircraft and a swarm launch
from three directions and stream toward Changi at 1 Hz.

*The GCS relays each track's position once a second over the same data
channel. Every map — here, in Japan — draws the same trajectory, the ETA, and
which device is responsible. Three tracks, three fallback chains.*

**Switch to the Command tab, press ⤢ fit.** Three coloured trajectories.
**Hover a head** for speed and position count. On the **responsible** device
(the label under each track says which), **press NEUTRALISED** on the missile
before its 45 s run out: the head turns ✔ and the stream stops. **Let the
aircraft fly.** When a track reaches the asset while still live, it turns
✖ **IMPACT** — the defence leaked, and every device knows it.

### 5:00 — Escalation

**Run scenario `probe-aircraft`** (150 s to impact). Note the responsible node
on the label. **Kill that node** in the fleet panel of whichever device runs
it. Within about ten seconds the label changes: the **Engagement timeline**
shows `escalated (dead) → <next system>` on every device.

*Responsibility moved to the next alive system in the fallback chain, with no
message from anyone — every node derived it from membership. The same happens
if the responsible station simply does nothing for 60 seconds.*

**Neutralise it from the new responsible device**, or hand it over.

### 6:00 — When the network is gone

**Press 🗺 offline map** in the map header. The island redraws from a bundled
58 KB dataset; markers and trajectories are unchanged.

*If the venue Wi-Fi drops, the mesh on this machine keeps running, the map
keeps working, and when connectivity returns the remote device is re-adopted
— the same join path it used the first time.*

Optional, if judges ask about the lighthouses: **kill all three.** Nothing
changes for the running mesh; only a brand-new join would wait.

### 6:30 — Access control (Lighthouse tab)

**Switch to the Lighthouse tab.** It lists who is registered, from which
device, with which incarnation. In a terminal:

```sh
cd backend-network-mesh && MESH_KEY=wrong-key npx tsx src/node.ts --id intruder --port 4099 --http 8099 --service api --lighthouses 127.0.0.1:5001
```

The tab's **rejected packets** counter climbs and the log shows
`REJECTED packet from 127.0.0.1:4099` in red. `Ctrl-C` the intruder.

*Every packet is encrypted and authenticated with a key derived from the mesh
key — AES-256-GCM, nothing but Node's built-in crypto. A node without it
cannot join, cannot be heard, cannot inject a threat, and cannot read what the
mesh says. The key is shared out of band and rotated by restarting with a new
one.*

## What is real and what is simulated

Judges will ask. Answer plainly:

- **Real:** the membership protocol, failure detection, NAT traversal through
  the public lighthouse, the flooded data channel, deterministic matchmaking,
  the replicated engagement lifecycle with authorisation and escalation,
  encrypted and replay-protected transport. Two physical devices on
  different continents.
- **Simulated:** the threats and their trajectories (the control plane drives
  them), the five "defence systems" (they are mesh nodes with a skill table,
  not sensors or effectors).
- **Not done, by choice:** per-device identities (one shared key — anyone
  holding it can claim any device name, and a leaked key exposes the whole
  mesh), a real sensor feed. `PLAN.md` §6 has the design for each.

## Terminal equivalents

Everything the UI does is an HTTP call to the control plane; these run
against `http://127.0.0.1:7070` (or the tunnelled `7071` for the VM).

```sh
node scripts/smoke.mjs                              # boot, converge, 4 threats, signal, lifecycle — PASS
curl -s -X POST localhost:7070/api/geo/seed          # demo layout
node scripts/scenario.mjs --list                    # the four scenarios
node scripts/scenario.mjs saturation                # run one and follow every transition
curl -s -X POST localhost:7070/api/procs/aegis-<device>/kill
curl -s -X POST localhost:7070/api/procs/aegis-<device>/start
curl -s -X POST localhost:7070/api/tracks/<trackId>/neutralise -H 'content-type: application/json' -d '{"station":"demo"}'
curl -s localhost:7070/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.tracks.map(t=>`${t.threat} ${t.state} ${t.responsibleDevice} ${t.agree}/${t.seenBy.length}`).join("\n"))})'
```

`node scripts/scenario.mjs` exits 0 only when every launched track ended with
all local nodes agreeing — a useful last check before the judges sit down.

## If something goes wrong

| Symptom | Do this |
|---|---|
| Remote device card red or missing | The VM is down or its key differs. Present with one device: everything except step 2:00 works locally; say so. `az vm start` takes ~1 min; nodes rejoin on their own. |
| Map shows `tiles unreachable → bundled basemap` | Venue has no internet. That *is* the 6:00 step; move on. |
| A track will not neutralise | You are on the wrong device: the label names the responsible one. Command mode has a logged **override** if you must. |
| A track is stuck live | `cancel` it in the GCS launcher (sends `track.lost`), or `curl -X DELETE localhost:7070/api/sim/tracks/<id>`. |
| `4/5 agree` or `3/5` on a fresh signal | Views had not converged at that instant (someone was just killed or revived). Wait two seconds; it settles. Say that this is the point of showing the count. |
| Two Macs on one network keep suspecting each other's nodes (log full of `→ suspect` / `refuting rumor`) | They are reaching each other through the router's public address instead of the LAN. Put each other's LAN address in `EXTRA_LIGHTHOUSES` (find it with `backend-network-mesh/scripts/find-lighthouses.ts`). If the finder sees nothing and neighbours do not even answer `ping`, the Wi-Fi isolates clients (home routers and venue guest networks often do): use a wired switch or a phone hotspot for the two Macs. Wider timers (`MESH_PROFILE=internet`) do not help — measured 2026-09-15, the hairpin drops packets rather than delaying them. Membership survives through the VM relay path, but the log stays noisy and agreement can take a retry. |
| Two GCS tabs on the same device show different station names | Station name is per browser tab (localStorage). Cosmetic. |
| `docker compose up` fails with a port in use | A native mesh or an old container holds UDP 4001-4008 / 5001-5003. `docker compose down`, kill stray `tsx` processes, retry. |
| Dashboard on 7000 says 403 | That is macOS AirPlay. The dashboard is on **7070**. |
