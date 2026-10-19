"use client";

// StreamGuard Console — time formatting helpers.
// All timestamps render LTR mono (HH:mm:ss.SSS) with full ISO in a tooltip.
import { useEffect, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useT } from "./primitives";

/** HH:mm:ss.SSS (local time) from an ISO string. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** YYYY-MM-DD HH:mm:ss (local) — used in tooltips and dense secondary displays. */
export function fmtFull(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact date for chart axes. */
export function fmtChartTick(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relativeMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Date.now() - t;
}

/** Mono timestamp with full ISO tooltip. */
export function MonoTime({
  iso,
  className,
  full = false,
}: {
  iso: string | null | undefined;
  className?: string;
  full?: boolean;
}) {
  const main = full ? fmtFull(iso) : fmtTime(iso);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dir="ltr" className={cn("sg-num cursor-default whitespace-nowrap", className)} dateTime={iso ?? undefined}>
          {main}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span dir="ltr" className="sg-num">
          {iso ?? "—"}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** "3m ago" style relative time, i18n-aware; numbers stay latin mono.
 * Live: one shared 30 s ticker re-renders every mounted TimeAgo so lists
 * don't freeze at stale labels (single interval regardless of row count). */
const tickers = new Set<() => void>();
let tickerTimer: ReturnType<typeof setInterval> | null = null;

function ensureTicker(): void {
  if (tickerTimer) return;
  tickerTimer = setInterval(() => {
    for (const fn of tickers) fn();
  }, 30_000);
}

function useTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const fn = () => setN((v) => v + 1);
    tickers.add(fn);
    ensureTicker();
    return () => {
      tickers.delete(fn);
    };
  }, []);
  return n;
}

export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const T = useT();
  useTick(); // live refresh — the label itself is computed below on every render
  const ms = relativeMs(iso);
  let label: string;
  if (ms === null) label = "—";
  else if (ms < 10_000) label = T("ago.justNow");
  else if (ms < 60_000) label = T("ago.seconds", { n: Math.floor(ms / 1000) });
  else if (ms < 3_600_000) label = T("ago.minutes", { n: Math.floor(ms / 60_000) });
  else if (ms < 86_400_000) label = T("ago.hours", { n: Math.floor(ms / 3_600_000) });
  else if (ms < 7 * 86_400_000) label = T("ago.days", { n: Math.floor(ms / 86_400_000) });
  else if (ms < 30 * 86_400_000) label = T("ago.weeks", { n: Math.floor(ms / (7 * 86_400_000)) });
  else if (ms < 365 * 86_400_000) label = T("ago.months", { n: Math.floor(ms / (30 * 86_400_000)) });
  else label = T("ago.years", { n: Math.floor(ms / (365 * 86_400_000)) });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time className={cn("whitespace-nowrap", className)} dateTime={iso ?? undefined}>
          {label}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span dir="ltr" className="sg-num">
          {fmtFull(iso)}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Uptime seconds → "2d 4h 13m". */
export function fmtUptime(sec: number): ReactNode {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return <span dir="ltr" className="sg-num">{parts.join(" ")}</span>;
}
