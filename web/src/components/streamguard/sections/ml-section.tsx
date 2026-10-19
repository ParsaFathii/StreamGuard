"use client";

// StreamGuard Console — Section 9: ML Analytics (anomaly detection + evaluation).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, ApiError } from "@/lib/api-client";
import type { MethodMetrics, SessionUser } from "@/lib/types";
import { isAnalystPlus } from "@/lib/store";
import {
  ErrorState,
  SectionHeader,
  SkeletonCards,
  SkeletonTable,
  StatusChip,
  useT,
} from "../primitives";
import { CHART, ChartTooltipShell, useChartRtl } from "../charts";
import { fmtChartTick, fmtFull } from "../time";

const IFORST_THRESHOLD = 0.61; // documented model threshold (CONTRACT.md)

export function MlSection({ user }: { user: SessionUser }) {
  const T = useT();
  const qc = useQueryClient();
  const canRun = isAnalystPlus(user.role);
  const { rtl, xAxis, yAxis, mirrorMargin } = useChartRtl();

  const ml = useQuery({ queryKey: ["ml"], queryFn: api.ml, refetchInterval: 60_000 });

  const evaluateMutation = useMutation({
    mutationFn: () => api.mlEvaluate(),
    onSuccess: () => {
      toast.success(T("toasts.evaluationDone"));
      qc.invalidateQueries({ queryKey: ["ml"] });
    },
    onError: (err: Error) =>
      toast.error((err as ApiError).status === 403 ? T("toasts.forbidden") : T("toasts.evaluationFailed")),
  });

  if (ml.isError) {
    return (
      <div className="space-y-4">
        <SectionHeader title={T("ml.title")} desc={T("navDesc.ml")} />
        <ErrorState message={(ml.error as Error)?.message} onRetry={() => ml.refetch()} />
      </div>
    );
  }

  const data = ml.data;
  const chartData = (data?.anomalyTimeline ?? []).map((p) => ({
    t: p.bucketStart,
    rate: p.rate,
    score: p.iforestScore,
    anomalyRate: p.isAnomaly ? p.rate : null,
  }));

  const baselines = data?.currentBaselines ?? [];
  const evaluation = data?.lastEvaluation ?? null;

  return (
    <div className="space-y-4">
      <SectionHeader
        title={T("ml.title")}
        desc={T("navDesc.ml")}
        actions={
          canRun ? (
            <Button size="sm" disabled={evaluateMutation.isPending} onClick={() => evaluateMutation.mutate()}>
              {evaluateMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
              {evaluateMutation.isPending ? T("ml.evaluationRunning") : T("ml.runEvaluation")}
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">{T("ml.viewerHint")}</span>
          )
        }
      />

      {ml.isLoading || !data ? (
        <div className="space-y-4">
          <SkeletonCards count={2} className="sm:grid-cols-2" />
          <SkeletonTable rows={5} cols={5} />
        </div>
      ) : (
        <>
          {/* model card */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{T("ml.modelVersion")}</p>
              <p dir="ltr" className="sg-num mt-1 text-sm font-semibold">{data.modelVersion}</p>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{T("ml.method")}</p>
              <p dir="ltr" className="mt-1 font-mono text-xs leading-snug">{data.method}</p>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{T("ml.features")}</p>
              <p dir="ltr" className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground">{T("ml.featuresList")}</p>
            </div>
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{T("ml.anomalyThreshold")}</p>
              <p dir="ltr" className="sg-num mt-1 text-sm font-semibold">
                {IFORST_THRESHOLD} <span className="text-[10px] font-normal text-muted-foreground">iforest &gt; θ</span>
              </p>
            </div>
          </div>

          {/* anomaly timeline */}
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-3 text-[13px] font-medium">{T("ml.anomalyTimeline")}</h3>
            {chartData.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">{T("states.empty")}</p>
            ) : (
              <div dir="ltr" className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={mirrorMargin({ top: 4, right: 12, bottom: 0, left: 8 })}>
                    <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="t"
                      {...xAxis}
                      tickFormatter={(v: string) => fmtChartTick(v)}
                      stroke={CHART.axis}
                      tick={{ fill: CHART.axis, fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: CHART.grid }}
                      interval="preserveStartEnd"
                      minTickGap={64}
                    />
                    {/* each Y axis is color-coded to its series and titled — no ambiguity which line belongs to which scale */}
                    <YAxis
                      yAxisId="rate"
                      {...yAxis}
                      stroke={CHART.emerald}
                      tick={{ fill: CHART.emerald, fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      label={{
                        value: T("ml.rateAxis"),
                        angle: rtl ? 90 : -90,
                        position: rtl ? "insideRight" : "insideLeft",
                        style: { fill: CHART.emerald, fontSize: 10 },
                      }}
                    />
                    <YAxis
                      yAxisId="score"
                      orientation={rtl ? "left" : "right"}
                      domain={[0, 1]}
                      stroke={CHART.teal}
                      tick={{ fill: CHART.teal, fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      label={{
                        value: T("ml.scoreAxis"),
                        angle: rtl ? -90 : 90,
                        position: rtl ? "insideLeft" : "insideRight",
                        style: { fill: CHART.teal, fontSize: 10 },
                      }}
                    />
                    <Tooltip
                      content={({ active, payload, label }) =>
                        active && payload?.length ? (
                          <ChartTooltipShell>
                            <span className="sg-num block text-muted-foreground">{fmtChartTick(String(label))}</span>
                            {payload.map((p) => (
                              <span key={String(p.name)} className="sg-num block" style={{ color: p.color }}>
                                {p.name}: {String(p.value)}
                              </span>
                            ))}
                          </ChartTooltipShell>
                        ) : null
                      }
                    />
                    <Legend
                      align={rtl ? "right" : "center"}
                      wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }}
                    />
                    <ReferenceLine yAxisId="score" y={IFORST_THRESHOLD} stroke={CHART.amber} strokeDasharray="4 4" />
                    <Line yAxisId="rate" dataKey="rate" name={T("ml.rate")} stroke={CHART.emerald} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line yAxisId="score" dataKey="score" name={T("ml.iforestScore")} stroke={CHART.teal} strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                    <Scatter yAxisId="rate" dataKey="anomalyRate" name={T("ml.anomaly")} fill={CHART.rose} shape="circle" isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* baselines */}
          <div className="rounded-md border border-border bg-card">
            <div className="border-b border-border px-3 py-2">
              <h3 className="text-[13px] font-medium">{T("ml.baselines")}</h3>
            </div>
            <div className="overflow-x-auto">
              <Table className="sg-table">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col">{T("common.source")}</TableHead>
                    <TableHead scope="col" className="text-end">{T("ml.ewmaRate")}</TableHead>
                    <TableHead scope="col" className="text-end">{T("ml.currentRate")}</TableHead>
                    <TableHead scope="col" className="text-end">{T("ml.zscoreCol")}</TableHead>
                    <TableHead scope="col">{T("ml.status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {baselines.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-xs text-muted-foreground">
                        {T("states.empty")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    baselines.map((b) => (
                      <TableRow key={b.sourceId}>
                        <TableCell dir="ltr" className="font-mono text-[11px]">{b.sourceId}</TableCell>
                        <TableCell dir="ltr" className="text-end font-mono text-[11px]">{b.ewmaRate.toFixed(2)}</TableCell>
                        <TableCell dir="ltr" className="text-end font-mono text-[11px]">{b.currentRate.toFixed(2)}</TableCell>
                        <TableCell dir="ltr" className="text-end font-mono text-[11px]">{b.zscore.toFixed(2)}</TableCell>
                        <TableCell>
                          <StatusChip tone={b.status === "anomalous" ? "error" : b.status === "elevated" ? "warn" : "ok"}>
                            {T(`ml.${b.status}`)}
                          </StatusChip>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* evaluation */}
          <div className="rounded-md border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-medium">{T("ml.evaluation")}</h3>
              <p className="text-[11px] text-muted-foreground">
                {T("ml.lastRun")}:{" "}
                {evaluation ? <span dir="ltr" className="sg-num">{fmtFull(evaluation.ts)}</span> : T("ml.neverRun")}
              </p>
            </div>

            {!evaluation ? (
              <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
                <p className="text-xs text-muted-foreground">
                  {canRun ? T("ml.runEvaluation") : T("ml.neverRun")}
                </p>
                {canRun && (
                  <Button size="sm" variant="outline" className="mt-3" disabled={evaluateMutation.isPending} onClick={() => evaluateMutation.mutate()}>
                    {evaluateMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                    {T("ml.runEvaluation")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <StatusChip tone="muted">
                    {T("ml.dataset")}: {T("ml.datasetLabel")} · <span dir="ltr" className="sg-num">{evaluation.datasetInfo.anomalies}</span> {T("ml.anomalies")} · <span dir="ltr" className="sg-num">{evaluation.datasetInfo.normal}</span> {T("ml.normalPoints")} · <span dir="ltr" className="sg-num">n={evaluation.datasetSize}</span>
                  </StatusChip>
                  <StatusChip tone="ok">{T("ml.seedNote", { n: evaluation.seed ?? 42 })}</StatusChip>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {(["rules", "zscore", "iforest"] as const).map((m) => (
                    <MethodCard key={m} name={T(`ml.methods.${m}`)} metrics={evaluation.methods[m]} />
                  ))}
                </div>

                <p className="text-[10px] text-muted-foreground">⚠ {T("ml.footnote")}</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MethodCard({ name, metrics }: { name: string; metrics: MethodMetrics }) {
  const T = useT();
  const fmt = (n: number) => (n * 100).toFixed(1) + "%";
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <p className="mb-2 text-xs font-semibold">{name}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
        <dt className="text-muted-foreground">{T("ml.precision")}</dt>
        <dd dir="ltr" className="text-end">{fmt(metrics.precision)}</dd>
        <dt className="text-muted-foreground">{T("ml.recall")}</dt>
        <dd dir="ltr" className="text-end">{fmt(metrics.recall)}</dd>
        <dt className="text-muted-foreground">{T("ml.f1")}</dt>
        <dd dir="ltr" className="text-end text-emerald-600 dark:text-emerald-400">{fmt(metrics.f1)}</dd>
        <dt className="text-muted-foreground">{T("ml.fpr")}</dt>
        <dd dir="ltr" className="text-end">{fmt(metrics.fpr)}</dd>
      </dl>
      <div className="mt-2 border-t border-border pt-2">
        <p className="mb-1 text-[10px] text-muted-foreground">{T("ml.confusion")}</p>
        <div dir="ltr" className="sg-num grid grid-cols-2 gap-0.5 text-center text-[10px]">
          <span className="rounded bg-emerald-500/15 px-1 py-0.5 text-emerald-700 dark:text-emerald-400">{T("ml.tp")} {metrics.confusion.tp}</span>
          <span className="rounded bg-rose-500/15 px-1 py-0.5 text-rose-600 dark:text-rose-400">{T("ml.fp")} {metrics.confusion.fp}</span>
          <span className="rounded bg-rose-500/10 px-1 py-0.5 text-rose-600/80 dark:text-rose-300/80">{T("ml.fn")} {metrics.confusion.fn}</span>
          <span className="rounded bg-secondary px-1 py-0.5 text-muted-foreground">{T("ml.tn")} {metrics.confusion.tn}</span>
        </div>
      </div>
    </div>
  );
}
