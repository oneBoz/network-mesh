// Composite the closing sequence: self-healing clip → 0.3 s dissolve → swarm clip
// (last frame held 1.5 s) with captions, the AEGIS focus ring and the end card,
// then a fade to black. Output is ~25 s; place it so it ends at 2:00.
//   node build-closing.mjs <workdir> [--out closing-sequence.mp4]   env FFMPEG=<path to ffmpeg with libx264>
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openTab, sleep } from "./lib.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const WORK = args.find((a) => !a.startsWith("--")) ?? "closing";
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? args[i + 1] : join(HERE, "closing-sequence.mp4"); })();
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const SH = join(HERE, "segment6-self-healing.mp4"), SW = join(HERE, "swarm-engage-neutralise.mp4");

// Timeline in composite seconds. The self-healing clip runs 0–12; the swarm clip
// starts at 11.7 (under a 0.3 s dissolve) and its last frame is held to 25.2.
const XF = 0.3, SW0 = 11.7, HOLD = 1.5, END = 12 + SW0 - XF + HOLD + XF; // 25.2
const swt = (t) => SW0 + t; // swarm clip time → composite time (beats from swarm-take.json / encode output)
const LAYERS = [
  ["sh1", 0.0, 1.6], ["sh2", 1.6, 4.2], ["sh3", 4.2, 6.3], ["sh4", 6.3, 8.0], ["sh5", 8.0, 9.8], ["sh6", 9.8, SW0],
  ["ring", 1.6, 9.8],
  ["sw1", swt(0), swt(2.2)], ["sw2", swt(2.2), swt(3.9)], ["sw3", swt(3.9), swt(8.6)], ["sw4", swt(8.6), swt(9.9)], ["sw5", swt(9.9), swt(10.9)], // hands over to the end card
  ["end", swt(10.9), END, { fadeIn: 0.7, fadeOut: 0 }],
];

mkdirSync(WORK, { recursive: true });
const tab = await openTab({ out: WORK, width: 1920, height: 1080, scale: 1, port: 9337 });
await tab.goto(`file://${join(HERE, "overlays.html")}`, 800);
for (const [id] of LAYERS) { if (!(await tab.evaluate(`show(${JSON.stringify(id)})`))) throw new Error(`no layer ${id}`); await sleep(60); await tab.png(join(WORK, `${id}.png`)); }
tab.close();
copyFileSync(join(WORK, "end.png"), join(HERE, "endcard.png"));

const inputs = ["-i", SH, "-i", SW];
const f = [`[1:v]tpad=stop_mode=clone:stop_duration=${HOLD}[sw]`, `[0:v][sw]xfade=transition=fade:duration=${XF}:offset=${SW0}[b0]`];
LAYERS.forEach(([id, a, b, o = {}], k) => {
  const dur = b - a, fi = o.fadeIn ?? 0.25, fo = o.fadeOut ?? 0.25;
  inputs.push("-loop", "1", "-framerate", "30", "-t", dur.toFixed(3), "-i", join(WORK, `${id}.png`));
  const fades = [fi > 0 ? `fade=t=in:st=0:d=${fi}:alpha=1` : "", fo > 0 ? `fade=t=out:st=${(dur - fo).toFixed(3)}:d=${fo}:alpha=1` : ""].filter(Boolean).join(",");
  f.push(`[${k + 2}:v]format=rgba,${fades ? fades + "," : ""}setpts=PTS-STARTPTS+${a.toFixed(3)}/TB[o${k}]`);
  f.push(`[b${k}][o${k}]overlay=eof_action=pass:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'[b${k + 1}]`);
});
f.push(`[b${LAYERS.length}]fade=t=out:st=${(END - 0.4).toFixed(2)}:d=0.4,format=yuv420p[v]`);
const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", f.join(";"), "-map", "[v]", "-t", END.toFixed(2), "-r", "30", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", OUT], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`${OUT}: ${END.toFixed(1)} s · self-healing 0–12 · swarm from ${SW0} · end card from ${swt(10.9).toFixed(1)}`);
