import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LogEvent } from "./types";
import { Pill } from "./ui";

const PALETTE = ["#6fafff", "#3dd9a4", "#f2b33d", "#afa3fb", "#ee86cb", "#7dd3fc", "#fbbf24", "#c4b5fd"];

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

/** Live stdout of mesh processes, streamed from the backend over SSE. A `role="log"`
 *  region that autoscrolls only while you are at the bottom; scrolling up pauses it.
 *  Memoised: it re-renders when a batch of lines lands, not on every state push
 *  (pass a stable `filter`, or it re-renders anyway). */
export const EventLog = memo(function EventLog({ events, filter, height, tools }: {
  events: LogEvent[]; filter?: (e: LogEvent) => boolean; height?: number; tools?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true); // autoscroll only while the user is at the bottom
  const shown = filter ? events.filter(filter) : events;

  useEffect(() => {
    const el = ref.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [shown.length, pinned]);

  const onScroll = () => {
    const el = ref.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const jump = () => { const el = ref.current; if (el) { el.scrollTop = el.scrollHeight; setPinned(true); } };

  return (
    <>
      {(tools || !pinned) && (
        <div className="log-tools">
          {tools}
          {!pinned && <><Pill tone="warn">paused while you read</Pill><button type="button" className="btn sm quiet" onClick={jump}>Jump to latest</button></>}
        </div>
      )}
      <div className="log" ref={ref} onScroll={onScroll} role="log" aria-live="off" aria-label="Live log" style={height ? { maxHeight: height, height } : undefined}>
        {shown.map((e, i) => {
          const text = e.line.replace(/^\[[^\]]*\] \[[^\]]*\] /, ""); // strip node.ts's own timestamp+id prefix
          return (
            <div key={e.id ?? i} className={lineClass(text)}>
              <span className="src" style={{ color: colorFor(e.source) }}>{e.source}</span>
              <span>{text}</span>
            </div>
          );
        })}
        {!shown.length && <div className="muted">Waiting for events…</div>}
      </div>
    </>
  );
});
