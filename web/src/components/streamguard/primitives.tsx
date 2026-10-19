"use client";

// StreamGuard Console — shared UI primitives: severity/origin/status badges,
// section header, empty/error/skeleton states, connection badge, small helpers.
import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCcw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Severity, Origin, IncidentStatus } from "@/lib/types";
import { useUiStore } from "@/lib/store";
import { translate } from "@/lib/i18n";

export function useT() {
  const lang = useUiStore((s) => s.lang);
  return (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);
}

export function useLang() {
  return useUiStore((s) => s.lang);
}

/* ----------------------------- Severity ------------------------------- */

export const SEVERITY_UI: Record<Severity, { hex: string; text: string; chip: string; dot: string; bar: string }> = {
  critical: {
    hex: "#F43F5E",
    text: "text-rose-600 dark:text-rose-400",
    chip: "border-rose-600/30 bg-rose-500/10 text-rose-600 dark:border-rose-500/25 dark:text-rose-400",
    dot: "bg-rose-500",
    bar: "bg-rose-500",
  },
  high: {
    hex: "#F97316",
    text: "text-orange-600 dark:text-orange-400",
    chip: "border-orange-600/30 bg-orange-500/10 text-orange-600 dark:border-orange-500/25 dark:text-orange-400",
    dot: "bg-orange-500",
    bar: "bg-orange-500",
  },
  medium: {
    hex: "#FBBF24",
    text: "text-amber-600 dark:text-amber-300",
    chip: "border-amber-500/40 bg-amber-400/10 text-amber-700 dark:border-amber-400/25 dark:text-amber-300",
    dot: "bg-amber-400",
    bar: "bg-amber-400",
  },
  low: {
    hex: "#2DD4BF",
    text: "text-teal-600 dark:text-teal-300",
    chip: "border-teal-500/40 bg-teal-400/10 text-teal-700 dark:border-teal-400/25 dark:text-teal-300",
    dot: "bg-teal-400",
    bar: "bg-teal-400",
  },
  info: {
    hex: "#94A3B8",
    text: "text-slate-500 dark:text-slate-400",
    chip: "border-slate-400/40 bg-slate-400/10 text-slate-600 dark:border-slate-400/25 dark:text-slate-400",
    dot: "bg-slate-400",
    bar: "bg-slate-400",
  },
};

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function severityAtLeast(a: Severity, min: Severity): boolean {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(min);
}

export function SeverityDot({ severity, className }: { severity: Severity; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", SEVERITY_UI[severity].dot, className)} />;
}

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const T = useT();
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        SEVERITY_UI[severity].chip,
        className,
      )}
    >
      <SeverityDot severity={severity} />
      {T(`sev.${severity}`)}
    </span>
  );
}

/* ------------------------------- Origin -------------------------------- */

export function OriginBadge({ origin, className }: { origin: Origin | string | null | undefined; className?: string }) {
  const T = useT();
  if (!origin) return null;
  if (origin === "synthetic") {
    return (
      <span
        className={cn(
          "inline-flex w-fit items-center rounded border border-amber-500/50 bg-amber-400/10 px-1 py-px text-[10px] font-semibold uppercase leading-none tracking-wide text-amber-700 dark:border-amber-400/40 dark:bg-transparent dark:text-amber-300",
          className,
        )}
        title={T("live.syntheticNote")}
      >
        {T("origin.synthetic")}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded border border-border px-1 py-px text-[10px] font-medium uppercase leading-none tracking-wide text-muted-foreground",
        className,
      )}
    >
      {T("origin.external")}
    </span>
  );
}

/* ------------------------------- Status -------------------------------- */

const INCIDENT_STATUS_UI: Record<IncidentStatus, string> = {
  NEW: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/25 dark:text-emerald-400",
  TRIAGED: "border-amber-500/40 bg-amber-400/10 text-amber-700 dark:border-amber-400/25 dark:text-amber-300",
  INVESTIGATING: "border-teal-500/40 bg-teal-400/10 text-teal-700 dark:border-teal-400/25 dark:text-teal-300",
  RESOLVED: "border-slate-400/40 bg-slate-400/10 text-slate-600 dark:border-slate-400/25 dark:text-slate-300",
  CLOSED: "border-border bg-secondary text-muted-foreground",
};

export function IncidentStatusChip({ status, className }: { status: IncidentStatus | string; className?: string }) {
  const T = useT();
  const cls = INCIDENT_STATUS_UI[status as IncidentStatus] ?? INCIDENT_STATUS_UI.NEW;
  return (
    <span className={cn("inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none", cls, className)}>
      {T(`incStatus.${status}`)}
    </span>
  );
}

export function DetectionStatusChip({ status, className }: { status: string; className?: string }) {
  const cls =
    status === "ACTIVE"
      ? "border-amber-500/40 bg-amber-400/10 text-amber-700 dark:border-amber-400/25 dark:text-amber-300"
      : "border-border bg-secondary text-muted-foreground";
  return (
    <span className={cn("inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-none", cls, className)}>
      {status}
    </span>
  );
}

export function EventStatusChip({ status, className }: { status: string; className?: string }) {
  const cls =
    status === "REJECTED"
      ? "border-rose-600/30 bg-rose-500/10 text-rose-600 dark:border-rose-500/25 dark:text-rose-400"
      : status === "PROCESSED"
        ? "border-teal-500/40 bg-teal-400/10 text-teal-700 dark:border-teal-400/25 dark:text-teal-300"
        : "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/25 dark:text-emerald-400";
  return (
    <span className={cn("inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none", cls, className)}>
      {status}
    </span>
  );
}

/** Generic ok/warn/error chip. */
export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: "ok" | "warn" | "error" | "muted";
  children: ReactNode;
  className?: string;
}) {
  const cls = {
    ok: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/25 dark:text-emerald-400",
    warn: "border-amber-500/40 bg-amber-400/10 text-amber-700 dark:border-amber-400/25 dark:text-amber-300",
    error: "border-rose-600/30 bg-rose-500/10 text-rose-600 dark:border-rose-500/25 dark:text-rose-400",
    muted: "border-border bg-secondary text-muted-foreground",
  }[tone];
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none", cls, className)}>
      {children}
    </span>
  );
}

/* --------------------------- Connection badge --------------------------- */

export function ConnectionBadge() {
  const T = useT();
  const status = useUiStore((s) => s.wsStatus);
  const label =
    status === "live" ? T("topbar.live") : status === "reconnecting" ? T("topbar.reconnecting") : status === "disconnected" ? T("topbar.disconnected") : T("topbar.stale");
  const cls =
    status === "live"
      ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400"
      : status === "reconnecting"
        ? "border-amber-500/40 bg-amber-400/10 text-amber-700 dark:border-amber-400/40 dark:text-amber-300"
        : "border-rose-600/40 bg-rose-500/10 text-rose-600 dark:border-rose-500/40 dark:text-rose-400";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[10px] font-semibold tracking-wider",
            cls,
          )}
          role="status"
          aria-label={label}
        >
          {(status === "live" || status === "reconnecting") && (
            <span className={cn("size-1.5 rounded-full bg-current", status === "live" && "sg-pulse")} />
          )}
          {status === "disconnected" && <WifiOff className="size-3" />}
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{status === "live" ? T("topbar.connectedAt") : T("live.disconnected")}</TooltipContent>
    </Tooltip>
  );
}

/* ----------------------------- Section header --------------------------- */

export function SectionHeader({
  title,
  desc,
  actions,
}: {
  title: string;
  desc?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------ States ---------------------------------- */

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 py-10 text-center", className)}>
      <div className="text-muted-foreground/60">{icon ?? <Inbox className="size-7" />}</div>
      <p className="text-[13px] font-medium">{title}</p>
      {hint && <p className="max-w-md text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const T = useT();
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-md border border-rose-500/20 bg-rose-500/5 px-6 py-8 text-center", className)}>
      <AlertTriangle className="size-6 text-rose-600 dark:text-rose-400" />
      <p className="text-[13px] font-medium">{T("states.errorTitle")}</p>
      <p className="max-w-md text-xs text-muted-foreground">{message ?? T("states.errorBody")}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} className="mt-2">
          <RefreshCcw className="size-3.5" /> {T("common.retry")}
        </Button>
      )}
    </div>
  );
}

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-7 w-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-1.5">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className={cn("h-8 flex-1", j === 0 && "max-w-24")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  );
}

/* ------------------------------ Small bits ------------------------------ */

export function KeyboardHint({ kbd, label }: { kbd: string; label?: string }) {
  const T = useT();
  return (
    <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:inline-flex">
      {label ?? T("topbar.search")}
      <span className="sg-kbd">{kbd}</span>
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span dir="ltr" className={cn("sg-num inline-block", className)}>
      {children}
    </span>
  );
}

export function Delta({ value, goodWhenDown, suffix, title }: { value: number | null; goodWhenDown?: boolean; suffix?: string; title?: string }) {
  const T = useT();
  if (value === null || !isFinite(value))
    return (
      <span title={T("common.noPriorData")} className="sg-num text-[11px] leading-none text-muted-foreground/70">
        —
      </span>
    );
  const up = value > 0;
  const good = goodWhenDown ? !up : up;
  const cls = value === 0 ? "text-muted-foreground" : good ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const arrow = value === 0 ? "→" : up ? "▲" : "▼";
  return (
    <span title={title} className={cn("sg-num text-[11px] leading-none", cls)}>
      {arrow} {Math.abs(value) < 1 ? value.toFixed(1) : Math.round(value)}%{suffix ?? ""}
    </span>
  );
}

/** Simple horizontal bar used in breakdown lists. */
export function MeterBar({
  value,
  max,
  color,
  className,
}: {
  value: number;
  max: number;
  color: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-secondary", className)}>
      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export { Badge };
