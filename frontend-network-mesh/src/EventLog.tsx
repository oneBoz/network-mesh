import { useEffect, useRef } from "react";
import type { LogEvent } from "./types";

const PALETTE = ["#3e9bff", "#2dd4a7", "#f5b841", "#8b7cf6", "#ff8fa3", "#5eead4", "#fbbf24", "#c4b5fd"];

function colorFor(source: string): string {
  if (source === "backend") return "var(--muted)";
  let h = 0;
  for (const c of source) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Live stdout of every mesh process, streamed from the backend over SSE. */
export function EventLog({ events }: { events: LogEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // autoscroll only while the user is at the bottom

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="panel log-panel">
      <h2>Live log</h2>
      <div className="log" ref={ref} onScroll={onScroll}>
        {events.map((e, i) => (
          <div key={i}>
            <span className="src" style={{ color: colorFor(e.source) }}>{e.source}</span>
            {/* node.ts prefixes its own timestamp+id — strip them, the UI shows the source */}
            <span>{e.line.replace(/^\[[^\]]*\] \[[^\]]*\] /, "")}</span>
          </div>
        ))}
        {!events.length && <div style={{ color: "var(--muted)" }}>Waiting for events…</div>}
      </div>
    </div>
  );
}
