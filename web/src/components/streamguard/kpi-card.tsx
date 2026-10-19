"use client";

// StreamGuard Console — KPI card: mono value + secondary line (bottom-left)
// + optional sparkline (bottom-right). One consistent geometry for every card.
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Delta, Mono } from "./primitives";
import { Sparkline } from "./charts";

export function KpiCard({
  label,
  value,
  unit,
  sub,
  delta,
  deltaTitle,
  goodWhenDown,
  sparkData,
  sparkColor,
  loading,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  delta?: number | null;
  /** Tooltip explaining the comparison window (e.g. "vs previous 2h"). */
  deltaTitle?: string;
  goodWhenDown?: boolean;
  sparkData?: Array<Record<string, string | number>>;
  sparkColor?: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="p-4">
          <Skeleton className="mb-2 h-3 w-24" />
          <Skeleton className="mb-3 h-8 w-20" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  const hasDelta = delta !== undefined;
  const hasSub = sub !== undefined && sub !== null && sub !== false;

  return (
    <Card className="group border-border bg-card transition-colors hover:border-[var(--sg-border-strong)]">
      <CardContent className="flex h-full flex-col p-4">
        <p className="mb-1.5 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>

        {/* value row — large mono, left-aligned, identical on every card */}
        <div className="flex items-baseline gap-1.5">
          <Mono className="text-2xl font-semibold leading-none">{value}</Mono>
          {unit && <span className="text-[11px] text-muted-foreground">{unit}</span>}
        </div>

        {/* secondary line anchored to the bottom: delta + sub bottom-LEFT,
            sparkline bottom-RIGHT with a fixed width so cards line up */}
        <div className="mt-auto flex min-h-[36px] items-end gap-2 pt-2">
          <div className="flex min-w-0 flex-col items-start gap-1 text-start">
            {hasDelta && <Delta value={delta ?? null} goodWhenDown={goodWhenDown} title={deltaTitle} />}
            {hasSub && <span dir="auto" className="min-w-0 text-[10px] leading-tight text-muted-foreground">{sub}</span>}
          </div>
          {sparkData && sparkData.length > 0 ? (
            <div className="ms-auto w-24 shrink-0">
              <Sparkline data={sparkData} color={sparkColor} height={36} />
            </div>
          ) : (
            <div aria-hidden className="ms-auto w-24 shrink-0" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
