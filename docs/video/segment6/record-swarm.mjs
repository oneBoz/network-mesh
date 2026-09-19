// Segment: a mock drone swarm, engaged and neutralised. The Mac's GCS reports a
// simulated swarm inbound from the Singapore Strait; the responsible GCS for a
// swarm is on azure-vm, so this records the *VM's* GCS console (through an SSH
// tunnel, `ssh -N -L 7071:127.0.0.1:7070 azureuser@<vm>`) where the Engage and
// Neutralised buttons exist, and clicks them with a drawn cursor.
//   node record-swarm.mjs <outdir>     env: CONSOLE (default :7071), REPORTER (default :7070)
import { openTab, post, getState, until, sleep } from "./lib.mjs";
const CONSOLE = process.env.CONSOLE ?? "http://127.0.0.1:7071"; // whose screen we record and who engages
const REPORTER = process.env.REPORTER ?? "http://127.0.0.1:7070"; // whose GCS launches the swarm
const OUT = process.argv[2] ?? "take-swarm";
const TARGET = process.env.TARGET ?? "asset-changi";
const ORIGIN = { lat: 1.24, lng: 103.9 }; // Singapore Strait, ~16 km south-west of Changi: the trail crosses open map with room for its label
const ETA_MS = 25_000; // short enough that the trail visibly grows in ten seconds; neutralised long before impact
const me = (await getState(CONSOLE)).device;
const reporter = (await getState(REPORTER)).device;
const trackOf = async (id) => (await getState(CONSOLE)).tracks.find((t) => t.trackId === id);

const tab = await openTab({ out: OUT, width: 1920, height: 1080, scale: 1 }); // the GCS console fits 1080 lines at 1:1
await tab.goto(`${CONSOLE}/?mode=gcs`, 5000);
await tab.showCursor(960, 700);
await tab.record();
await sleep(1500); // calm map, no targets
const info = await post(REPORTER, "/api/sim/tracks", { threat: "swarm", origin: ORIGIN, target: TARGET, etaMs: ETA_MS, station: `GCS-${reporter}`, note: "3 contacts, low and fast" });
if (!info.trackId) throw new Error(`launch failed: ${JSON.stringify(info)}`);
tab.mark(`launched ${info.trackId} from ${reporter}`);
const [t1, w1] = await until(async () => { const t = await trackOf(info.trackId); return t && t.responsibleDevice === me && t.state === "detected" ? t : null; }, 15000, `${me} to be responsible`);
tab.mark(`detected, responsible ${t1.responsibleDevice} (${t1.responsibleNode}) +${w1} ms`);
await sleep(2000); // "waiting on this station" tile and the first trail segments land
tab.mark("engage-click"); await tab.click("Engage"); tab.mark("engage-sent");
const [, w2] = await until(async () => (await trackOf(info.trackId))?.state === "engaging", 10000, "engaging");
tab.mark(`engaging +${w2} ms`);
await sleep(3500); // trail grows while the engagement runs
tab.mark("neutralise-click"); await tab.click("Neutralised"); tab.mark("neutralise-sent");
const [t3, w3] = await until(async () => { const t = await trackOf(info.trackId); return t?.state === "neutralised" ? t : null; }, 10000, "neutralised");
tab.mark(`neutralised by ${t3.neutralised?.station ?? t3.neutralised?.device} +${w3} ms · ${t3.agree}/${t3.seenBy?.length} agree`);
await sleep(2500);
await tab.stop({ console: me, reporter, trackId: info.trackId });
