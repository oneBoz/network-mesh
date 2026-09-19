# Segment 6 — Maelstrom Command, self-healing mesh (1:48–2:00)

Two ways to fill the 12-second slot. The rendered clip is the one to use; the
stills remain as a fallback for a Figma-only build.

## Route A — the rendered clip (recommended)

`segment6-self-healing.mp4` is a 12 s, 1920 × 1080, 30 fps H.264 clip recorded
live from the Command dashboard on 19 September: a visible cursor kills AEGIS
in the Fleet panel, the mesh suspects then convicts it, the fallback numbers on
every other node drop by one, the cursor revives it, and a fresh missile
matchmakes to the same node as before. Drop it into the editor at 1:48 and add
the persistent label and lower thirds on top.

Two honest compressions were applied, and the caption should say so in one
line, for example **"self-healing mesh · timers shortened for the demo · 1.4×"**:

| Compression | What | Why |
|---|---|---|
| Mesh timers | Local fleet ran with `PROTOCOL_PERIOD_MS=500` and `SUSPECT_TIMEOUT_MS=1500` (defaults 1000 / 5000). | With ~12 members the suspect → dead window scales to 10 s, so the real sequence takes 17–20 s. |
| Playback | The 16.7 s take is played at 1.43× to land on 12.0 s. | Everything else (probe timing, gossip, dashboard polling) is real. |

Beat sheet, in clip time (from `take.json`):

| Clip time | Beat | Lower third |
|---|---|---|
| 0.0 s | Healthy: strip **5 of 5 alive**, missile already assigned, AEGIS carries fallback badge 2. | Healthy mesh · every node agrees 5/5 |
| 1.0 s | Cursor clicks **Kill** on the AEGIS row. Process shows down; the mesh has not noticed. | Node severed |
| 4.2 s | AEGIS becomes a dashed amber ring; strip drops to **4 of 5**. | Peers stop hearing it → suspect |
| 6.3 s | Red cross badge: convicted dead. Missile re-injected; EDGE 7 → 6, FALCON 4 → 3, SmartFalcon 5 → 4. | Convicted dead → out of the capability pool |
| 8.0 s | Cursor clicks **Revive**. | Node rejoins |
| 9.8 s | Filled green glyph, **5 of 5** again. Missile re-injected: AEGIS badge 2, others back to 7 / 4 / 5. | Rediscovered · same assignment as before |

Persistent label for the whole segment (top-left, small):
**Maelstrom Command — self-healing mesh (simulated network)**

The frame is the dashboard at 80 % zoom so the status strip, the topology and
the Fleet rows all fit in 1080 lines; there are ~210 px of dark margin either
side. Crop to 1500 px wide and scale up if the edit wants full-bleed, at the
cost of the top of the strip.

### Re-recording

Needs a running local fleet with the shortened timers, Google Chrome, and an
ffmpeg with libx264 (`brew install ffmpeg`, or `npm i ffmpeg-static` and point
`FFMPEG` at the binary). From the repo root:

    PROTOCOL_PERIOD_MS=500 SUSPECT_TIMEOUT_MS=1500 docker compose up -d
    curl -s -X POST 127.0.0.1:7070/api/demo        # then wait ~20 s for the remote devices
    node docs/video/segment6/record.mjs /tmp/take   # ~30 s; frames + take.json
    node docs/video/segment6/encode.mjs /tmp/take --target 12 --out docs/video/segment6/segment6-self-healing.mp4
    docker compose up -d && curl -s -X POST 127.0.0.1:7070/api/demo   # back to default timers

`record.mjs` waits for the dashboard's own consensus rule at each step instead
of fixed sleeps, so a take is as short as the mesh allows; `encode.mjs` speeds
up uniformly only if the take is longer than the target and freezes the last
frame if it is shorter. `NODE_ID` picks a different victim.

## Second clip — mock swarm, engaged and neutralised

`swarm-engage-neutralise.mp4` is a 12 s, 1920 × 1080, 30 fps H.264 clip for a
slot that needs the engagement lifecycle rather than the self-healing story.
The Mac's GCS reports a simulated drone swarm inbound from the Singapore
Strait toward Changi Airbase; the responsible GCS for a swarm is MAELSTROM
Command on **azure-vm**, so the clip is the Azure VM's GCS console (recorded
through an SSH tunnel), where the Engage and Neutralised buttons exist. A
drawn cursor clicks them. Only one compression: the 14.1 s take is played at
1.18×; mesh timers are the defaults.

| Clip time | Beat | Lower third |
|---|---|---|
| 0.0 s | Calm console: **0 targets** waiting on this station, map with the six defended assets. | Azure VM · GCS console |
| 1.3 s | Swarm reported by GCS-dingyi-mac. Within a second every device matchmakes it to MAELSTROM on azure-vm: **Waiting on this station 1 target**, trail appears in the Strait, **5/5 agree**. | Swarm reported from the Mac · matchmade to this station |
| 3.9 s | Cursor clicks **Engage**; the pill turns to *engaging*, the map head reads "SWARM engaging · ETA". | Engage |
| 8.6 s | Cursor clicks **Neutralised**. | Neutralised |
| 9.9 s | "✔ neutralised by GCS-azure-vm", **0 targets** waiting, map head "SWARM ✔ neutralised", **5/5 agree** on every device. | Neutralised · replicated to every device |

Persistent label: **Maelstrom Command — engagement lifecycle (simulated
swarm)**. The offline second Mac (`mac02 0/2`, a red marker near Paya Lebar)
happened to be re-learned from a lighthouse registry during this take; it is
the mesh honestly showing a registered device that is down.

Re-recording, from the repo root with both fleets up:

    ssh -f -N -L 7071:127.0.0.1:7070 azureuser@23.100.103.160   # the VM console on :7071
    node docs/video/segment6/record-swarm.mjs /tmp/swarm          # launches from :7070, records :7071
    node docs/video/segment6/encode.mjs /tmp/swarm --target 12 --out docs/video/segment6/swarm-engage-neutralise.mp4

Restart both fleets first if the timeline should start empty (`docker restart
network-mesh` on each, then `POST /api/demo`). `CONSOLE` and `REPORTER`
override the two dashboards; `TARGET` picks another asset.

## The assembled closing sequence

`closing-sequence.mp4` (25.2 s, 1920 × 1080, 30 fps H.264) is both clips cut
together with captions, the AEGIS focus ring, the end card and a fade to
black, ready to drop in as the last 25 s of the two-minute video: start it at
**1:34.8** so it ends at 2:00, or trim the front of the self-healing clip if
row 5 cannot lose the time.

| Composite time | What | On-screen |
|---|---|---|
| 0.0–11.7 | Self-healing clip (Mac, Command view). Captions sit inside the empty engagement-timeline panel; an amber ring marks AEGIS from the kill to the rejoin. | Healthy 5/5 → Node severed → suspect → dead, out of the pool → rejoins → rediscovered |
| 11.7–12.0 | 0.3 s dissolve. The header does the explaining: "Command · dingyi-mac" becomes "GCS · azure-vm". | — |
| 11.7–22.6 | Swarm clip (Azure VM, GCS console). Captions bottom-left, where nothing is drawn. | Same mesh, seen from the Azure VM in Japan → reported from the Mac, matchmade here → Engage → Neutralised → replicated, 5/5 agree |
| 22.6–25.2 | Last frame held and dimmed; end card fades in over "✔ neutralised · 5/5 agree"; fade to black over the final 0.4 s. | MAELSTROM · tagline · proof line · credits |

Everything on screen comes from `overlays.html`, in the dashboard's own colours
and system type: edit the caption text there, and fill in the `CREDITS` array
(team, mentor, date) so the end card carries names, then rebuild:

    FFMPEG=/path/to/ffmpeg node docs/video/segment6/build-closing.mjs /tmp/closing

`build-closing.mjs` renders each layer to a transparent PNG with headless
Chrome, then composites with one ffmpeg filter graph (`xfade`, `tpad`, timed
`overlay`s with alpha fades). Beat times are constants at the top of the
script; they come from the two takes' `encode.mjs` output. `endcard.png` is the
end card alone, for a still or a Figma frame.

Music note: let the last hit land on the Neutralised click at about 20.3 s and
decay under the card.

## Route B — six stills in Figma

Six real captures (1920 × 1080) from the same sequence at default timers, two
seconds each. Use these if the video has to be assembled inside Figma.

| # | Time | Frame | What the viewer should notice |
|---|---|---|---|
| 1 | 1:48 | `01-healthy.png` | Strip **5 of 5 alive**; AEGIS filled green with badge **2**. |
| 2 | 1:50 | `02-severed.png` | One second after the kill: process down, mesh unaware. |
| 3 | 1:52 | `03-suspect.png` | Dashed amber ring; strip **4 of 5**. |
| 4 | 1:54 | `04-dead-out-of-chain.png` | Red cross badge; fallback numbers move down one. |
| 5 | 1:56 | `05-rejoined.png` | Filled green again; **5 of 5**. |
| 6 | 1:58 | `06-rediscovered.png` | Badge **2** back, others return to 8 / 5 / 3. |

1. **File.** One page `Segment 6`, six 1920 × 1080 frames `6.1` … `6.6` with the
   PNGs as fills at 100 %.
2. **Lower third.** On `6.1`, a 1200 × 72 rectangle at x 40, y 968, fill
   `#151D2B` at 92 %, 12 px corners, 1 px stroke `#26314A`. Text SF Pro Text
   (or Inter) 28 / Semibold `#E8EDF4`, left-padded 24 px. Make it a component;
   one instance per frame. Segment label 20 / Medium `#9AA7BD` at x 40, y 24.
3. **Focus ring (optional).** 2 px `#F2B33D` ellipse, 84 × 84, around the
   AEGIS glyph (about x 720, y 608), 40 % opacity, on frames 6.2–6.5.
4. **Prototype.** `6.1 → … → 6.6`, After delay 2000 ms, Dissolve 300 ms, Ease
   out. Not Smart Animate: it will try to slide the timeline rows.
5. **Export.** Figma prototypes do not export as video: present full-screen and
   screen-record 12 s, or render with ffmpeg from the stills:

       ffmpeg -framerate 0.5 -pattern_type glob -i '0*.png' -vf "fps=30,format=yuv420p" -c:v libx264 -crf 18 segment6-stills.mp4

`seq.mjs` reproduces the stills against a running dashboard at default timers
(about 40 s per run).
