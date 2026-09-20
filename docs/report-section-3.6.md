# 3.6 MAELSTROM Command

> Figures: one per subsection in `docs/report-figures/` (`fig-3.6.png` … `fig-3.6.4.png`, 3200 × 1800 on white). Edit `figures.html` there and run `node render.mjs` to regenerate.

MAELSTROM Command is the command-and-control layer of the combined defence: a self-healing mesh that connects every partner system into one entity with no central server. Each defence system, whether it runs on the same machine or on another continent, is represented by a lightweight node in the mesh. The nodes discover each other, detect failures in seconds, agree independently on which system should answer a threat, and replicate the engagement from first report to neutralisation on every device. MAELSTROM also fields the Layer 1 anti-swarm effector, which takes part in the same orchestration as every partner system. The whole stack is written in TypeScript on Node.js built-ins, with a React dashboard, and ships as one Docker image that any device can run.

## 3.6.1 Architecture Overview

The system is layered in three parts.

**The mesh.** Every node is a small UDP process. Lighthouses act as join brokers only: a node announces itself to them, learns who else is present, and from then on communicates peer to peer. Membership uses the SWIM protocol: each node probes one random peer every second, asks two helpers to probe on its behalf if the direct probe times out, then marks the peer *suspect* and convicts it *dead* after a window that grows with the size of the mesh. A wrongly accused node refutes the accusation with a higher incarnation number. Rumours about members ride on the probes themselves, so there is no broadcast and no central member table. Nodes on different networks reach each other through NAT hole punching with keepalives, and a node that cannot reach a peer directly probes it through a helper that can. Every frame is encrypted with AES-256-GCM under a key derived from a shared secret; a device without the key can neither join nor read.

**The decisions on top.** The same gossip channel floods application messages, deduplicated by id: threat reports from ground control stations, track positions once per second, and the engage, hand-over and neutralised actions. Nothing is decided centrally. Each node runs the identical deterministic matchmaker over its own view of who is alive, and each node applies the identical engagement reducer to the same messages, so both the assignment and the engagement state are replicated on every device without a coordination round trip.

**The control plane and dashboard.** One container per device spawns the local lighthouses and nodes as child processes, polls their small HTTP query interfaces once a second, and pushes only the changed state to the browser over server-sent events. It also owns everything that is simulated in the demonstration: the location table, the trajectory simulator and the scripted scenarios. The dashboard offers a Command view (map or topology of what the mesh believes, fleet controls, engagement timeline, cross-node agreement), a GCS view (report a threat, engage and neutralise what this station owns, launch a simulated target) and a Lighthouse view (the join registries).

In the demonstration configuration each device runs three lighthouses and five nodes, one per defence system. Every device's nodes also join a lighthouse on a public Azure virtual machine in Japan, so fleets on separate networks merge into one mesh.

## 3.6.2 Capability-Aware Orchestration

Every node carries a capability declaration: the threat types it can engage, the defence layer it belongs to, and a relative cost of using it. The declarations used in the demonstration are:

| System | Engages | Layer | Cost |
|---|---|---|---|
| MAELSTROM (Layer 1 anti-swarm) | swarm | 1 | 8 |
| AEGIS | missile, aircraft | 2 | 5 |
| SmartFalcon | missile, aircraft | 3 | 5 |
| EdgeFuse | missile, aircraft, swarm | 4 | 6 |
| WISL | EMP, swarm | 5 | 2 |

When a threat is reported, every node matchmakes it independently: filter the currently alive nodes to those whose declaration covers the threat type, then order them by layer, then cost, then identifier. Because the ordering is total and the input is each node's converged membership view, every node computes the identical primary and the identical fallback chain. The mesh therefore acts as one entity with no leader election and no negotiation. A missile, for example, resolves to AEGIS first, then SmartFalcon, then EdgeFuse; a swarm resolves to MAELSTROM's Layer 1 effector first, then EdgeFuse, then WISL.

Escalation is not a separate mechanism. If the primary system's node is convicted dead, it simply disappears from the alive filter, and the next matchmake returns the fallback. Conversely, when a node rejoins, it is rediscovered within one probe cycle and resumes its position in the chain. Responsibility is enforced by the same rule at the engagement level: only the device that currently holds the primary may engage or neutralise a track, and an action from anyone else is recorded as rejected on every node. A Command operator may override this, and the override is logged as such.

Because the same code runs on every node, the mesh's answer can be audited: the dashboard shows the assignment as computed by each local node and reports how many of them agree, which in a converged mesh is all of them.

## 3.6.3 Integration with Partner Teams

Each partner system integrates by running one MAELSTROM node alongside its own software. The node needs a service name, a capability declaration, the shared mesh key and the address of at least one lighthouse; from there it joins the mesh, is discovered by every other node, and is placed in every fallback chain it qualifies for. In the demonstration the five systems, AEGIS (Layer 2, close-combat interception), SmartFalcon (Layer 3, interception if AEGIS fails), EdgeFuse (Layer 4, on-sensor fused detection for counter-swarm), WISL (EMP defence and jamming) and MAELSTROM's own Layer 1 effector, are represented by nodes with those declarations on each device.

Partner software talks to its node over a local, token-protected HTTP interface rather than to the mesh directly. It can originate a message that the node floods to every member, report a threat and receive the mesh's assignment, read the current membership with each peer's status, read the replicated track table with each track's state and responsible device, and check the node's health. Assignments and engagement events also arrive at every node as the mesh floods them, so a partner system learns that it has been made responsible for a track from its own node, not from a central server.

The message vocabulary is small and fixed: a ground-control signal, a threat assignment, and the track lifecycle events detected, update, engaging, hand-over, neutralised, lost and impact. Any station on any device may report; only the responsible device's actions are accepted.

In this hackathon the partner systems were represented by their nodes and declarations rather than by live hardware; connecting a real effector means pointing its control software at the local node interface.

## 3.6.4 Demonstrated Capabilities

The following were shown live during development and are reproducible with the scripts in the repository.

- **Self-healing membership across the internet.** A mesh of fifteen nodes on three devices, a MacBook in Singapore, a second Mac, and an Azure virtual machine in Japan, joined through a public lighthouse, with peers behind NAT reached by hole punching. Killing a node's process is noticed by its peers within a few seconds, convicted after the suspect window, and the node is rediscovered within a probe cycle of being revived.

- **Encryption end to end.** Every gossip and application frame is AES-256-GCM; the lighthouses report the encryption state and the pre-demo check refuses to run without it.

- **One-entity decisions.** Threat reports injected from any node produce the identical assignment and fallback chain on every node, verified by comparing all local nodes' answers (5 of 5 in every check). When the primary's node is killed, the next report resolves to the fallback with no other change; when it is revived, the assignment returns to the original.

- **Replicated engagement lifecycle.** A simulated drone swarm reported from the Mac was matchmade to MAELSTROM on the Azure VM within about one second, engaged and neutralised from the VM's ground-control console, and every device showed the same state with all nodes in agreement. Attempts from a non-responsible device are rejected and logged.

- **Simulated tracks at 1 Hz.** Launched targets stream their trajectory to every device once a second, and scripted scenarios (single cruise missile, two swarm waves, saturation attack, aircraft probe) exercise the chain end to end.

- **Operational readiness.** A judging-day preflight script checks the dashboard, fleet, encryption, local convergence, remote devices, map layout, map tiles and cross-node signal agreement, and reports GO or NO-GO with the reason. Container memory per device is about 285 MB for the full fleet, and the dashboard receives only changed state slices, so it stays responsive on a projector laptop.
