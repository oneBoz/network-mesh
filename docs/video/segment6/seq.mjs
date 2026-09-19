// Drive one Chrome tab over CDP through the self-healing story and capture a 1920x1080 frame per beat.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const API = "http://127.0.0.1:7070";
const port = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const chrome = spawn(CH, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
let ok = false; for (let i = 0; i < 40 && !ok; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); ok = true; } catch { await sleep(250); } }
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`storyboard/${name}.png`, Buffer.from(s.data, "base64")); console.log(`${new Date().toISOString().slice(11, 19)} frame ${name}`); };
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${API}/?mode=command` }); await sleep(4000);
// Topology in the situation panel, diagnostics closed, scrolled to the top.
await send("Runtime.evaluate", { expression: `localStorage.setItem("mesh-situation-view","topology"); for (const k of ["matrix","resolve","log"]) localStorage.setItem("mesh-disc-"+k,"0"); location.reload();` });
await sleep(6000);
const NODE = "aegis-dingyi-mac";
await post("/api/threat", { threat: "missile" }); await sleep(2500);
await shot("01-healthy");
await post(`/api/procs/${NODE}/kill`); await sleep(1500);
await shot("02-severed");
await sleep(4000);
await shot("03-suspect");
// suspect → dead takes ~13 s with three devices' fleets in the view
await sleep(16000);
await post("/api/threat", { threat: "missile" }); await sleep(2500);
await shot("04-dead-out-of-chain");
await post(`/api/procs/${NODE}/start`); await sleep(4500);
await shot("05-rejoined");
await post("/api/threat", { threat: "missile" }); await sleep(2500);
await shot("06-rediscovered");
ws.close(); chrome.kill();
