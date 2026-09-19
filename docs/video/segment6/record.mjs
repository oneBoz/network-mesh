// Record the self-healing story live: one headless Chrome tab, CDP screencast,
// a visible synthetic cursor that clicks Kill and Revive in the Fleet panel.
// Frames land in <out>/frames/*.jpg with their timestamps in <out>/take.json;
// encode.mjs turns that into a 12 s mp4. Run the local fleet with shortened
// timers first (see segment6-figma-guide.md).
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const API = "http://127.0.0.1:7070";
const NODE = process.env.NODE_ID ?? "aegis-dingyi-mac";
const OUT = process.argv[2] ?? "take";
const port = 9335;
mkdirSync(join(OUT, "frames"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const belief = async () => { // majority view of NODE across reachable local observers (same rule as the dashboard)
  const s = await (await fetch(`${API}/api/state`)).json();
  const votes = { alive: 0, suspect: 0, dead: 0 }; let total = 0;
  for (const v of s.views) { if (!v.reachable) continue; const e = v.id === NODE ? { status: "alive" } : v.view[NODE]; if (!e) continue; votes[e.status]++; total++; }
  if (!total) return "unknown";
  const rank = { alive: 0, suspect: 1, dead: 2 };
  return Object.keys(votes).reduce((b, k) => votes[k] > votes[b] || (votes[k] === votes[b] && rank[k] > rank[b]) ? k : b);
};
const until = async (want, limitMs) => { const t0 = Date.now(); for (;;) { const b = await belief(); if (b === want) return Date.now() - t0; if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${want} (still ${b})`); await sleep(200); } };

const chrome = spawn(CH, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--window-size=2400,1350", "about:blank"], { stdio: "ignore" });
let ok = false; for (let i = 0; i < 40 && !ok; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); ok = true; } catch { await sleep(250); } }
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const frames = []; const marks = []; let recording = false; let n = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Page.screencastFrame") {
    const { data, metadata, sessionId } = m.params;
    if (recording) { const f = `frames/${String(++n).padStart(5, "0")}.jpg`; writeFileSync(join(OUT, f), Buffer.from(data, "base64")); frames.push({ f, t: metadata.timestamp }); }
    ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId } }));
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
const mark = (label) => { marks.push({ label, t: Date.now() / 1000 }); console.log(`${new Date().toISOString().slice(11, 23)} ${label}`); };

// 2400×1350 CSS px at 0.8 → a 1920×1080 frame that keeps the status strip, topology and the Fleet rows all in view.
await send("Emulation.setDeviceMetricsOverride", { width: 2400, height: 1350, deviceScaleFactor: 0.8, mobile: false });
await send("Page.navigate", { url: `${API}/?mode=command` }); await sleep(4000);
await evaluate(`localStorage.setItem("mesh-situation-view","topology"); for (const k of ["matrix","resolve","log"]) localStorage.setItem("mesh-disc-"+k,"0"); location.reload();`);
await sleep(5000);
// Synthetic cursor (headless renders none). Moves with a CSS transition so the screencast shows the approach.
await evaluate(`(() => { const c = document.createElement("div"); c.id = "democursor"; c.style.cssText = "position:fixed;left:1200px;top:900px;width:28px;height:28px;z-index:99999;pointer-events:none;transition:left .6s cubic-bezier(.2,.7,.2,1),top .6s cubic-bezier(.2,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))";
  c.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.5 L20 15.5 Z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>'; document.body.appendChild(c); })()`);
const buttonRect = (label) => evaluate(`(() => { const it = [...document.querySelectorAll(".list .item")].find((el) => el.textContent.includes(${JSON.stringify(NODE)})); const b = it && [...it.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const clickButton = async (label) => {
  const p = await buttonRect(label); if (!p) throw new Error(`no ${label} button for ${NODE}`);
  if (p.y > 1330 || p.x > 2380) throw new Error(`${label} button is off-screen at ${Math.round(p.x)},${Math.round(p.y)}`);
  await evaluate(`(() => { const c = document.getElementById("democursor"); c.style.left = "${p.x - 4}px"; c.style.top = "${p.y - 2}px"; })()`);
  await sleep(700);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await sleep(90);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
};

// Stage: a missile already on screen so the fallback badges are visible before the cut.
await post("/api/threat", { threat: "missile" }); await sleep(2500);
await until("alive", 10000);
await send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
recording = true; mark("start");
await sleep(1500);
mark("kill-click"); await clickButton("Kill"); mark("killed");
mark(`suspect +${await until("suspect", 15000)} ms`);
mark(`dead +${await until("dead", 20000)} ms`);
await sleep(600);
await post("/api/threat", { threat: "missile" }); mark("missile-while-dead");
await sleep(1800);
mark("revive-click"); await clickButton("Revive"); mark("revived");
mark(`alive +${await until("alive", 15000)} ms`);
await sleep(600);
await post("/api/threat", { threat: "missile" }); mark("missile-rediscovered");
await sleep(2000);
mark("end"); recording = false;
await send("Page.stopScreencast");
await evaluate(`document.getElementById("democursor")?.remove()`);
writeFileSync(join(OUT, "take.json"), JSON.stringify({ node: NODE, frames, marks }, null, 1));
console.log(`${frames.length} frames over ${(frames.at(-1).t - frames[0].t).toFixed(1)} s → ${OUT}/take.json`);
ws.close(); chrome.kill();
