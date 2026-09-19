// Turn a take from record.mjs into an mp4 of exactly --target seconds (default 12),
// scaling time uniformly if the take ran long. Needs ffmpeg with libx264 on PATH
// or in FFMPEG. Usage: node encode.mjs take [--target 12] [--out segment6.mp4]
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
const args = process.argv.slice(2);
const OUT = args.find((a) => !a.startsWith("--")) ?? "take";
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const target = Number(opt("target", 12));
const out = opt("out", "segment6-self-healing.mp4");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const { frames, marks } = JSON.parse(readFileSync(join(OUT, "take.json"), "utf8"));
// The screencast only emits on repaint, so the take really ends at the recorder's "end" mark, not at the last frame.
const t0 = frames[0].t, tEnd = marks.find((m) => m.label === "end")?.t ?? frames.at(-1).t + 0.5, dur = tEnd - t0;
const scale = dur > target ? target / dur : 1; // never slow a short take down; pad instead
const lines = ["ffconcat version 1.0"];
frames.forEach((fr, i) => { const next = i + 1 < frames.length ? frames[i + 1].t : tEnd; lines.push(`file '${resolve(OUT, fr.f)}'`, `duration ${((next - fr.t) * scale).toFixed(4)}`); });
lines.push(`file '${resolve(OUT, frames.at(-1).f)}'`); // concat demuxer quirk: repeat the last frame so its duration is honoured
writeFileSync(join(OUT, "list.txt"), lines.join("\n") + "\n");
const pad = target - dur * scale; // freeze the final frame to reach target exactly
const vf = `fps=30,scale=1920:1080:flags=lanczos,format=yuv420p${pad > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}` : ""}`;
const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(OUT, "list.txt"), "-vf", vf, "-t", String(target), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", out], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`${out}: ${target} s, ${frames.length} frames, take ${dur.toFixed(1)} s${scale < 1 ? ` sped up ${(1 / scale).toFixed(2)}×` : ""}`);
for (const m of marks) console.log(`  ${((m.t - t0) * scale).toFixed(1).padStart(5)} s  ${m.label}`);
