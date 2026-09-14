# Adding a device to the mesh

Any machine that can run Docker (or Node 22/24) becomes a full member: it runs
its own dashboard, its own five demo nodes, and sees every other device's nodes
through gossip. Follow the section that matches where the new device is.

## 0. What every device needs

- The repo: `git clone https://github.com/oneBoz/network-mesh.git && cd network-mesh`
- Docker Desktop (Mac/Windows) or Docker Engine (Linux). Native alternative:
  Node 22/24 and the steps in the root README.
- Outbound UDP allowed on its network (almost always true).
- A `.env` in the repo root, copied from `.env.example`. Three lines matter:

```
MESH_KEY=hackathon-demo-key          # identical on every device, or nothing talks
EXTRA_LIGHTHOUSES=<host:port,...>    # who to join — see below
DEVICE_NAME=<short unique name>      # e.g. mini-a, gcs-laptop; shows up on every other dashboard
```

`DEVICE_NAME` must be unique across the mesh: it is also the suffix of the
demo node ids (`aegis-mini-a`), and two devices with the same name would fight
over the same ids.

Then:

```sh
docker compose up -d
open http://localhost:7070       # click "Boot demo mesh"
node scripts/smoke.mjs           # optional: boots, converges, fires threats + a signal
```

## 1. Device on another network (home, office, hotspot)

Join the public lighthouse on the Azure VM:

```
EXTRA_LIGHTHOUSES=23.100.103.160:5001
```

That is all. No port forwarding, no public IP on the device. The lighthouse
records the device's NAT-mapped public address and hands it to everyone;
probes then run directly between devices (UDP hole punching), with the VM's
nodes as relays whenever a direct path is filtered.

Within ~10 s of **Boot demo mesh** the dashboard header shows
`n/m remote on k devices (...)` and the topology has a card per other device.

## 2. Device on the same LAN / behind the same router as an existing device

Two machines behind one router cannot reach each other at their **public**
address (routers rarely hairpin), so they must use LAN addresses. Point them
at each other's lighthouse, and optionally the VM as well:

```
# existing Mac, LAN 192.168.0.13            # new Mac, LAN 192.168.0.14
EXTRA_LIGHTHOUSES=192.168.0.14:5001,23.100.103.160:5001
                                            EXTRA_LIGHTHOUSES=192.168.0.13:5001,23.100.103.160:5001
```

Find a Mac's LAN address with `ipconfig getifaddr en0` (or `en1`); Linux:
`hostname -I`. The compose file already publishes UDP 5001-5003 and 4001-4008
on the host, so the other machine's join reaches this one's lighthouse.

If the LAN blocks device-to-device traffic (some campus/guest Wi-Fi), fall back
to section 1 only: the two devices will still see each other, kept alive
through the VM's relays, just without a direct path.

## 3. A new always-on public site (another VPS)

Give it a public IP, open inbound UDP 5001-5003 and 4001-4010, install Docker,
copy the repo, then either the lightweight site:

```sh
PUBLIC_IP=<its ip> MESH_KEY=hackathon-demo-key DEVICE_NAME=<name> \
  docker compose -f docker-compose.remote.yml up -d --build
```

or the full dashboard with host networking:

```sh
ADVERTISE=<its ip> DEVICE_NAME=<name> MESH_KEY=hackathon-demo-key \
  docker compose -p mesh-dashboard -f docker-compose.yml -f docker-compose.host.yml up -d --build
curl -s -X POST 127.0.0.1:7070/api/demo
```

`ADVERTISE`/`PUBLIC_IP` is mandatory here: a node that joins a lighthouse on
its own machine over loopback would otherwise be recorded as `127.0.0.1`.
Other devices then add `<its ip>:5001` to their `EXTRA_LIGHTHOUSES`. Several
public lighthouses can be listed; nodes announce to a random one every 30 s and
re-learn peers from the reply.

## 4. Check that it worked

On the new device:

```sh
curl -s localhost:7070/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s);console.log("device",st.device);for(const r of st.remotes)console.log(r.id,r.status,r.host+":"+r.port)})'
```

Every other device's nodes should be listed `alive`. On any existing device the
new one appears as a card in the topology and under **Other devices** with its
name and IP.

Then prove the data channel: switch the new device to **GCS** mode, report a
threat, and watch it appear in every other device's **GCS signals** panel with
the same actions and a green `5/5 agree`. Or from a terminal:

```sh
curl -s -X POST localhost:7070/api/signal -H 'content-type: application/json' \
  -d '{"threat":"swarm","station":"GCS-new-device","note":"hello from the new device"}'
```

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Header shows no remotes after 30 s | `MESH_KEY` differs (nodes log `bad HMAC signature`), `EXTRA_LIGHTHOUSES` typo, or outbound UDP blocked. `docker compose logs -f` and look for `joined mesh — learned N peers` on each node. |
| Remote nodes flicker between alive and suspect | Two devices behind the same router using public addresses — use section 2. Or the other device runs an older build — `docker compose up -d --build` there. |
| `id conflict` in a lighthouse log | Two devices with the same `DEVICE_NAME` (or a device booted with no `EXTRA_LIGHTHOUSES`, giving plain ids that collide with a hub's). Make names unique. |
| `timestamp outside the replay window` | Clocks differ by more than 60 s. Enable NTP on both machines. |
| Signal shows `n/5 agree` with n < 5 | Local views had not converged at that instant (a device was restarting, or suspicions were in flight). Send again once the topology is all green. |
| Mac: `http://localhost:7000` gives 403 | AirPlay owns 7000. The dashboard is on **7070**. |

## 6. Removing a device

Just `docker compose down` on it. Others mark its nodes suspect within a
second, dead after ~5-10 s, and forget them 30 s later. Nothing else changes.
