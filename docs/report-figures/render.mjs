// Render each figure in figures.html to fig-<id>.png at 2× (3200 × 1800) for print.
import { openTab, sleep } from "../video/segment6/lib.mjs";
import { dirname, join } from "node:path"; import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const IDS = ["3.6", "3.6.1", "3.6.2", "3.6.3", "3.6.4"];
const tab = await openTab({ out: process.argv[2] ?? "/tmp/figs", width: 1600, height: 900, scale: 2, port: 9338 });
await tab.goto(`file://${join(HERE, "figures.html")}`, 800);
for (const id of IDS) { if (!(await tab.evaluate(`show(${JSON.stringify(id)})`))) throw new Error(`no figure ${id}`); await sleep(80); await tab.png(join(HERE, `fig-${id}.png`)); console.log(`fig-${id}.png`); }
tab.close();
