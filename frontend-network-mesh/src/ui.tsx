/**
 * ui.tsx — shared primitives of the redesigned console (docs/WORKLOG.md, 2026-09-19).
 *
 * Status is encoded as shape and word before colour; threats have drawn glyphs
 * instead of emoji; every control has a visible label and a focus ring; the
 * only destructive action that fires without a confirmation sheet is Kill.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NodeStatus, ThreatType } from "./types";

export type Tone = "ok" | "warn" | "bad" | "info" | "lh" | "threat" | "neutral" | "solid";

/** Pill: a small tagged word. `dot` prefixes a status dot. */
export function Pill({ tone = "neutral", dot, children, title, className }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string; className?: string }) {
  return <span className={`pill ${tone}${className ? ` ${className}` : ""}`} title={title}>{dot && <span className="dot" aria-hidden="true" />}{children}</span>;
}

/** Status glyph: filled dot alive, dashed ring suspect, ring with a cross dead / process down,
 *  dotted ring unknown, diamond for lighthouses and assets. Decorative — the word sits next to it. */
export function StatusGlyph({ status, size = 14 }: { status: NodeStatus | "unknown" | "lh" | "asset" | "down"; size?: number }) {
  const c = status === "alive" ? "var(--alive)" : status === "suspect" ? "var(--suspect)" : status === "dead" || status === "down" ? "var(--dead)"
    : status === "lh" || status === "asset" ? "var(--lh)" : "var(--muted)";
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {status === "alive" && <circle cx="7" cy="7" r="5.5" fill={c} />}
      {status === "suspect" && <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="2" strokeDasharray="3 2" />}
      {(status === "dead" || status === "down") && <><circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="2" /><path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke={c} strokeWidth="1.6" /></>}
      {status === "unknown" && <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="1.5 2" />}
      {(status === "lh" || status === "asset") && <rect x="3" y="3" width="8" height="8" rx="1.5" fill="none" stroke={c} strokeWidth="2" transform="rotate(45 7 7)" />}
    </svg>
  );
}

export const STATUS_WORD: Record<NodeStatus | "unknown" | "down", string> = { alive: "alive", suspect: "suspect", dead: "dead", unknown: "unknown", down: "process down" };

/** Threat glyphs, drawn so they render identically everywhere and stay out of the accessibility tree. */
export function ThreatIcon({ type }: { type: ThreatType }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {type === "missile" && <><path d="M12 2c3 3 4 7 4 11l-4 3-4-3c0-4 1-8 4-11z" {...common} /><path d="M8 13l-3 4h4M16 13l3 4h-4M12 16v5" {...common} /></>}
      {type === "swarm" && <>{[[7, 8], [16, 6], [12, 14], [6, 17], [17, 16]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="2.2" fill="currentColor" />)}</>}
      {type === "aircraft" && <path d="M3 13l8-2V5l2-1 1 7 7 2v2l-7-1-1 6h-2l-1-6-7 1z" {...common} strokeWidth={1.6} />}
      {type === "emp" && <path d="M13 2L5 14h6l-1 8 9-13h-6z" {...common} />}
    </svg>
  );
}

export const THREAT_HINT: Record<ThreatType, string> = { missile: "ballistic / cruise", swarm: "drone swarm", aircraft: "manned / large UAV", emp: "electronic attack" };
export const THREAT_LABEL: Record<ThreatType, string> = { missile: "Missile", swarm: "Swarm", aircraft: "Aircraft", emp: "EMP" };

/** A labelled control: the label wraps the control, so clicking it focuses the field and screen readers name it. */
export function Field({ label, children, grow, className }: { label: string; children: ReactNode; grow?: boolean; className?: string }) {
  return <label className={`field${grow ? " grow" : ""}${className ? ` ${className}` : ""}`}><span className="field-label">{label}</span>{children}</label>;
}

export function PanelHead({ title, sub, right, children }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return <div className="panel-head"><h2>{title}</h2>{sub && <span className="sub">{sub}</span>}{children}{right && <span className="right">{right}</span>}</div>;
}

/** A collapsible panel. Open state is remembered per browser under `id`. */
export function Disclosure({ id, title, summary, defaultOpen = false, children }: { id: string; title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState<boolean>(() => {
    try { const v = localStorage.getItem(`mesh-disc-${id}`); return v === null ? defaultOpen : v === "1"; } catch { return defaultOpen; }
  });
  useEffect(() => { try { localStorage.setItem(`mesh-disc-${id}`, open ? "1" : "0"); } catch { /* ignore */ } }, [id, open]);
  return (
    <details className="disc" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{title}{summary && <span className="sub">{summary}</span>}</summary>
      <div className="disc-body">{open && children}</div>
    </details>
  );
}

/** Segmented control. `value` is the selected key. */
export function Segmented<T extends string>({ options, value, onChange, label, small }: { options: { key: T; label: ReactNode; title?: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div className={`seg${small ? " sm" : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} title={o.title} disabled={o.disabled} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

/** The "…" menu: a native disclosure, so it needs no positioning library and closes on Escape or an outside click. */
export function MoreMenu({ label, items }: { label: string; items: { label: string; destructive?: boolean; onClick: () => void }[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && ref.current?.open) ref.current.open = false; };
    document.addEventListener("click", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);
  return (
    <details className="menu" ref={ref}>
      <summary className="btn sm quiet" aria-label={label} title={label}>…</summary>
      <div className="menu-list" role="menu">
        {items.map((it) => (
          <button key={it.label} type="button" role="menuitem" className={it.destructive ? "destructive" : undefined}
            onClick={() => { if (ref.current) ref.current.open = false; it.onClick(); }}>{it.label}</button>
        ))}
      </div>
    </details>
  );
}

export interface ConfirmRequest { title: string; body: ReactNode; confirmLabel: string; destructive?: boolean; onConfirm: () => void }

/** Modal confirmation sheet. Focus lands on Cancel; Escape and the backdrop cancel. */
export function ConfirmSheet({ req, onClose }: { req: ConfirmRequest | null; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!req) return;
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [req, onClose]);
  if (!req) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId}>{req.title}</h2>
        <p>{req.body}</p>
        <div className="actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onClose}>Cancel</button>
          <button type="button" className={`btn ${req.destructive ? "destructive filled" : "primary"}`} onClick={() => { req.onConfirm(); onClose(); }}>{req.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/** A clock that ticks once a second, for "ago" text between state pushes. */
export function useNow(everyMs = 1_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}

export const ago = (ms: number) => (ms < 1_000 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);
export const uptime = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
