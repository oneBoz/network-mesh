// Shared bits for the demo recorders: a headless Chrome tab over CDP, a JPEG
// screencast with timestamps, and a drawn cursor that walks to a button and
// clicks it (headless renders no pointer of its own).
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const CH = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
export const getState = (base) => fetch(`${base}/api/state`).then((r) => r.json());
/** Poll fn() every 200 ms until it returns a truthy value; resolves [value, waitedMs]. */
export const until = async (fn, limitMs, what = "condition") => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return [v, Date.now() - t0]; if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}`); await sleep(200); } };

/** 2400×1350 CSS px at 0.8 → a 1920×1080 frame that keeps a whole dashboard view in shot. */
export async function openTab({ port = 9335, width = 2400, height = 1350, scale = 0.8, out = "take" } = {}) {
  mkdirSync(join(out, "frames"), { recursive: true });
  const chrome = spawn(CH, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let ok = false; for (let i = 0; i < 40 && !ok; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); ok = true; } catch { await sleep(250); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const frames = []; const marks = []; let recording = false; let n = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === "Page.screencastFrame") {
      const { data, metadata, sessionId } = m.params;
      if (recording) { const f = `frames/${String(++n).padStart(5, "0")}.jpg`; writeFileSync(join(out, f), Buffer.from(data, "base64")); frames.push({ f, t: metadata.timestamp }); }
      ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId } }));
    }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  const tab = {
    send, evaluate, frames, marks,
    mark(label) { marks.push({ label, t: Date.now() / 1000 }); console.log(`${new Date().toISOString().slice(11, 23)} ${label}`); },
    async goto(url, settleMs = 4000) { await send("Page.navigate", { url }); await sleep(settleMs); },
    async showCursor(x = width / 2, y = height / 2) {
      await evaluate(`(() => { document.getElementById("democursor")?.remove(); const c = document.createElement("div"); c.id = "democursor"; c.style.cssText = "position:fixed;left:${x}px;top:${y}px;width:28px;height:28px;z-index:99999;pointer-events:none;transition:left .6s cubic-bezier(.2,.7,.2,1),top .6s cubic-bezier(.2,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))";
        c.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.5 L20 15.5 Z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>'; document.body.appendChild(c); })()`);
    },
    /** Centre of the first visible button whose text is exactly `label`, optionally inside the element matching `within`. */
    buttonAt(label, within) {
      return evaluate(`(() => { const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : "document"}; if (!root) return null;
        const b = [...root.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && x.getBoundingClientRect().width > 0); if (!b) return null;
        const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    },
    async click(label, within) {
      const p = await tab.buttonAt(label, within); if (!p) throw new Error(`no visible "${label}" button`);
      if (p.y > height - 20 || p.x > width - 20 || p.y < 0) throw new Error(`"${label}" button is off-screen at ${Math.round(p.x)},${Math.round(p.y)}`);
      await evaluate(`(() => { const c = document.getElementById("democursor"); c.style.left = "${p.x - 4}px"; c.style.top = "${p.y - 2}px"; })()`);
      await sleep(700);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
      await sleep(90);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    },
    async record() { await send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }); recording = true; tab.mark("start"); },
    /** Transparent-background PNG of the current page (for caption overlays). */
    async png(path) { await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }); const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path, Buffer.from(s.data, "base64")); },
    close() { ws.close(); chrome.kill(); },
    async stop(extra = {}) {
      tab.mark("end"); recording = false; await send("Page.stopScreencast"); await evaluate(`document.getElementById("democursor")?.remove()`);
      writeFileSync(join(out, "take.json"), JSON.stringify({ ...extra, frames, marks }, null, 1));
      console.log(`${frames.length} frames over ${(frames.at(-1).t - frames[0].t).toFixed(1)} s → ${out}/take.json`);
      ws.close(); chrome.kill();
    },
  };
  return tab;
}
