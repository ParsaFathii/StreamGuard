"use client";

// StreamGuard Console — chart primitives (recharts, dark-first, NO blues).
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const CHART = {
  emerald: "#10B981",
  emeraldSoft: "#34D399",
  teal: "#2DD4BF",
  amber: "#FBBF24",
  orange: "#F97316",
  rose: "#F43F5E",
  slate: "#94A3B8",
  grid: "#1F2B26",
  axis: "#8CA39A",
};

export function ChartTooltipShell({ children }: { children: ReactNode }) {
  return (
    <div dir="ltr" className="rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur">
      {children}
    </div>
  );
}

/** Tiny sparkline — no axes, emerald stroke, subtle fill. */
export function Sparkline({
  data,
  color = CHART.emerald,
  height = 34,
  dataKey = "v",
  className,
}: {
  data: Array<Record<string, string | number>>;
  color?: string;
  height?: number;
  dataKey?: string;
  className?: string;
}) {
  if (!data.length) {
    return <div style={{ height }} className={cn("w-full rounded-sm bg-secondary/40", className)} />;
  }
  const id = `sg-spark-${color.replace("#", "")}`;
  return (
    <div dir="ltr" style={{ height }} className={cn("w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${id})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Labeled horizontal bar row (breakdowns, top sources). */
export function BarListRow({
  label,
  value,
  max,
  color,
  valueFormatter,
  valueClassName,
}: {
  label: ReactNode;
  value: number;
  max: number;
  color: string;
  valueFormatter?: (n: number) => ReactNode;
  /** Extra classes for the count value (e.g. severity-colored numbers). */
  valueClassName?: string;
}) {
  const pct = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <div className="group py-1">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-foreground/85">{label}</span>
        <span dir="ltr" className={cn("sg-num shrink-0 tabular-nums", valueClassName ?? "text-muted-foreground")}>
          {valueFormatter ? valueFormatter(value) : value.toLocaleString("en-US")}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
