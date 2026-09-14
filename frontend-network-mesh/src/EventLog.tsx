import { useEffect, useRef } from "react";
import type { LogEvent } from "./types";

const PALETTE = ["#3e9bff", "#2dd4a7", "#f5b841", "#8b7cf6", "#ff8fa3", "#5eead4", "#fbbf24", "#c4b5fd"];

function colorFor(source: string): string {
  if (source === "backend") return "var(--muted)";
  let h = 0;
  for (const c of source) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Colour a line by what it reports, so the important events stand out. */
function lineClass(line: string): string | undefined {
  if (/REJECTED|rejected packet|error/i.test(line)) return "log-bad";
  if (/moved|id conflict|suspect → dead|→ suspect/.test(line)) return "log-warn";
  if (/join:|joined mesh|→ alive|SIGNAL|adopted/.test(line)) return "log-good";
  return undefined;
}

/** Live stdout of mesh processes, streamed from the backend over SSE.
 *  `filter` narrows to some sources (e.g. only lighthouses). */
export function EventLog({ events, title = "Live log", filter, height }: {
  events: LogEvent[]; title?: string; filter?: (e: LogEvent) => boolean; height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // autoscroll only while the user is at the bottom
  const shown = filter ? events.filter(filter) : events;

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="panel log-panel">
      <h2>{title}</h2>
      <div className="log" ref={ref} onScroll={onScroll} style={height ? { height } : undefined}>
        {shown.map((e, i) => {
          const text = e.line.replace(/^\[[^\]]*\] \[[^\]]*\] /, ""); // strip node.ts's own timestamp+id prefix
          return (
            <div key={i} className={lineClass(text)}>
              <span className="src" style={{ color: colorFor(e.source) }}>{e.source}</span>
              <span>{text}</span>
            </div>
          );
        })}
        {!shown.length && <div style={{ color: "var(--muted)" }}>Waiting for events…</div>}
      </div>
    </div>
  );
}
