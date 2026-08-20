/**
 * cli.ts — tiny helpers shared by the two mesh executables
 * (node.ts and lighthouse.ts).
 */

/** `--flag value` pairs → { flag: value }; a bare `--flag` (followed by
 *  another flag or nothing) gets "true", anywhere in the argument list. */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[argv[i].slice(2)] = next;
      i++;
    } else {
      out[argv[i].slice(2)] = "true";
    }
  }
  return out;
}

/** Timestamped, tagged console logger: `[ISO time] [tag] message`. */
export function makeLogger(tag: string): (s: string) => void {
  return (s) => console.log(`[${new Date().toISOString()}] [${tag}] ${s}`);
}
