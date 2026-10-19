"use client";

// StreamGuard Console — Section 1: Operations Overview.
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SessionUser } from "@/lib/types";
import { api } from "@/lib/api-client";
import { useUiStore } from "@/lib/store";
import {
  ChartTooltipShell,
  CHART,
  BarListRow,
  useChartRtl,
} from "../charts";
import {
  ErrorState,
  IncidentStatusChip,
  SEVERITY_UI,
  SectionHeader,
  SeverityDot,
  StatusChip,
  useT,
} from "../primitives";
import { fmtChartTick, fmtUptime, TimeAgo } from "../time";
import { KpiCard } from "../kpi-card";
import { GenerateActivityButton } from "../simulator";

function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) return curr > 0 ? 100 : null;
  return ((curr - prev) / prev) * 100;
}

/** The API serves minute buckets only (points 10..240) — 240 min = 4 h window. */
const TS_POINTS = 240;
type MinuteSeries = Array<{ bucketStart: string; value: number }>;

/** Downsample a minute series into 10-minute sums (24 points for 240 min). */
function bucket10(d: MinuteSeries | undefined): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < (d?.length ?? 0); i += 10) {
    out.push({ v: (d ?? []).slice(i, i + 10).reduce((s, p) => s + p.value, 0) });
  }
  return out;
}

/** Last-2h vs prior-2h from a 4h minute series (API has no hourly/24h-ago aggregate). */
function windowDelta(d: MinuteSeries | undefined): number | null {
  if (!d || d.length < 120) return null;
  const half = Math.floor(d.length / 2);
  const recent = d.slice(-half).reduce((s, p) => s + p.value, 0);
  const prior = d.slice(0, half).reduce((s, p) => s + p.value, 0);
  return deltaPct(recent, prior);
}

export function OverviewSection({ user }: { user?: SessionUser | null }) {
  const T = useT();
  const openIncident = useUiStore((s) => s.openIncident);
  const { xAxis, yAxis, mirrorMargin } = useChartRtl();

  const overview = useQuery({ queryKey: ["overview"], queryFn: api.analyticsOverview, refetchInterval: 30_000 });
  // timeseries: minute buckets only (points ≤ 240); deltas compare last 2h vs prior 2h
  const tsEvents = useQuery({
    queryKey: ["timeseries", "events", TS_POINTS],
    queryFn: () => api.timeseries("events", TS_POINTS, "minute"),
    refetchInterval: 60_000,
  });
  const tsDetections = useQuery({
    queryKey: ["timeseries", "detections", TS_POINTS],
    queryFn: () => api.timeseries("detections", TS_POINTS, "minute"),
    refetchInterval: 60_000,
  });
  const tsRejected = useQuery({
    queryKey: ["timeseries", "rejected", TS_POINTS],
    queryFn: () => api.timeseries("rejected", TS_POINTS, "minute"),
    refetchInterval: 60_000,
  });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const recentIncidents = useQuery({
    queryKey: ["incidents", "recent5"],
    queryFn: () => api.incidents({ page: 1, pageSize: 5, sort: "createdAt" }),
  });

  const o = overview.data;
  const loading = overview.isLoading;

  const eventsDelta = windowDelta(tsEvents.data);
  const detectionsDelta = windowDelta(tsDetections.data);
  const rejectedDelta = windowDelta(tsRejected.data);

  const rates = o?.ingestRatePerMin ?? [];
  const last5 = rates.slice(-5).reduce((s, r) => s + r.count, 0) / Math.max(1, rates.slice(-5).length);
  const prev5 = rates.slice(-10, -5).reduce((s, r) => s + r.count, 0) / Math.max(1, rates.slice(-10, -5).length);
  const ingestDelta = rates.length >= 6 ? deltaPct(last5, prev5) : null;

  const severityEntries = o
    ? (["critical", "high", "medium", "low", "info"] as const).map((s) => ({
        key: s,
        count: o.severityBreakdown24h?.[s] ?? 0,
      }))
    : [];
  const severityMax = Math.max(1, ...severityEntries.map((e) => e.count));

  const categoryEntries = o
    ? Object.entries(o.categoryBreakdown24h ?? {})
        .map(([k, v]) => ({ key: k, count: Number(v) }))
        .sort((a, b) => b.count - a.count)
    : [];
  const categoryMax = Math.max(1, ...categoryEntries.map((e) => e.count));

  const topSources = o?.topSources24h ?? [];
  const sourceMax = Math.max(1, ...topSources.map((s) => Number(s.count)));

  const chartData = rates.map((r) => ({ t: r.minute, v: r.count }));

  if (overview.isError) {
    return (
      <div className="space-y-4">
        <SectionHeader title={T("overview.title")} desc={T("navDesc.overview")} />
        <ErrorState message={(overview.error as Error)?.message} onRetry={() => overview.refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={T("overview.title")}
        desc={T("navDesc.overview")}
        actions={<GenerateActivityButton user={user} />}
      />

      {/* KPI row — one consistent geometry: mono value, secondary line bottom-left, sparkline bottom-right */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          loading={loading}
          label={T("overview.kpiEvents24h")}
          value={(o?.totals.events24h ?? 0).toLocaleString("en-US")}
          delta={eventsDelta}
          deltaTitle={T("overview.vsPrev2h")}
          sparkData={bucket10(tsEvents.data)}
          sparkColor={CHART.emerald}
          sub={
            <>
              {T("overview.events7dSub")}: <span dir="ltr" className="sg-num">{(o?.totals.events7d ?? 0).toLocaleString("en-US")}</span>
            </>
          }
        />
        <KpiCard
          loading={loading}
          label={T("overview.kpiIngestRate")}
          value={rates.length ? Math.round(last5).toLocaleString("en-US") : "—"}
          unit={T("overview.perMin")}
          delta={ingestDelta}
          deltaTitle={T("overview.vsPrev5m")}
          sparkData={rates.map((r) => ({ v: r.count }))}
          sparkColor={CHART.teal}
        />
        <KpiCard
          loading={loading}
          label={T("overview.kpiDetections24h")}
          value={(o?.totals.detections24h ?? 0).toLocaleString("en-US")}
          delta={detectionsDelta}
          deltaTitle={T("overview.vsPrev2h")}
          goodWhenDown
          sparkData={bucket10(tsDetections.data)}
          sparkColor={CHART.amber}
        />
        <KpiCard
          loading={loading}
          label={T("overview.kpiOpenIncidents")}
          value={(o?.totals.incidentsOpen ?? 0).toLocaleString("en-US")}
          goodWhenDown
          sub={
            <>
              {T("overview.duplicates24h")}: <span dir="ltr" className="sg-num">{(o?.totals.duplicates24h ?? 0).toLocaleString("en-US")}</span>
            </>
          }
        />
        <KpiCard
          loading={loading}
          label={T("overview.kpiRejected24h")}
          value={(o?.totals.rejected24h ?? 0).toLocaleString("en-US")}
          delta={rejectedDelta}
          deltaTitle={T("overview.vsPrev2h")}
          goodWhenDown
          sparkData={bucket10(tsRejected.data)}
          sparkColor={CHART.rose}
        />
        <KpiCard
          loading={loading}
          label={T("overview.kpiAvgLatency")}
          value={o ? Math.round(o.processing.avgLatencyMs24h ?? 0).toLocaleString("en-US") : "—"}
          unit="ms"
          goodWhenDown
          sub={
            <>
              {T("overview.p95Latency")}: <span dir="ltr" className="sg-num">{o ? Math.round(o.processing.p95LatencyMs24h ?? 0) : "—"}<span className="ms-0.5">ms</span></span>
            </>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* middle: charts */}
        <div className="space-y-4 xl:col-span-2">
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-3 text-[13px] font-medium">{T("overview.ingestChart")}</h3>
            {chartData.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
                {loading ? T("common.loading") : T("states.empty")}
              </div>
            ) : (
              <div dir="ltr" className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={mirrorMargin({ top: 4, right: 8, bottom: 0, left: -18 })}>
                    <defs>
                      <linearGradient id="sg-ingest" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART.emerald} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={CHART.emerald} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="t"
                      {...xAxis}
                      tickFormatter={(v: string) => fmtChartTick(v)}
                      stroke={CHART.axis}
                      tick={{ fill: CHART.axis, fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: CHART.grid }}
                      interval={9}
                      minTickGap={28}
                    />
                    <YAxis {...yAxis} stroke={CHART.axis} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      content={({ active, payload, label }) =>
                        active && payload?.length ? (
                          <ChartTooltipShell>
                            <span className="sg-num block text-muted-foreground">{fmtChartTick(String(label))}</span>
                            <span className="sg-num font-semibold text-emerald-600 dark:text-emerald-400">
                              {String(payload[0]?.value)} events
                            </span>
                          </ChartTooltipShell>
                        ) : null
                      }
                    />
                    <Area dataKey="v" stroke={CHART.emerald} strokeWidth={1.5} fill="url(#sg-ingest)" isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-2 text-[13px] font-medium">{T("overview.severityBreakdown")}</h3>
              <div className="pe-1">
                {severityEntries.map((e) => (
                  <BarListRow
                    key={e.key}
                    label={
                      <span className="flex items-center gap-1.5">
                        <SeverityDot severity={e.key} /> {T(`sev.${e.key}`)}
                      </span>
                    }
                    value={e.count}
                    max={severityMax}
                    color={CHART[ e.key === "critical" ? "rose" : e.key === "high" ? "orange" : e.key === "medium" ? "amber" : e.key === "low" ? "lime" : "slate"]}
                    valueClassName={SEVERITY_UI[e.key].text}
                  />
                ))}
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-2 text-[13px] font-medium">{T("overview.categoryBreakdown")}</h3>
              <div className="pe-1">
                {categoryEntries.length === 0 && !loading ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">{T("states.empty")}</p>
                ) : (
                  categoryEntries.map((e) => (
                    <BarListRow
                      key={e.key}
                      label={<span className="font-mono text-[11px]">{e.key}</span>}
                      value={Number(e.count)}
                      max={categoryMax}
                      color={CHART.emerald}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* right rail */}
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-2 text-[13px] font-medium">{T("overview.topSources")}</h3>
            <div className="pe-1">
              {topSources.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">{T("states.empty")}</p>
              ) : (
                topSources.map((s) => (
                  <BarListRow
                    key={s.sourceId}
                    label={<span className="font-mono text-[11px]">{s.sourceId}</span>}
                    value={s.count}
                    max={sourceMax}
                    color={CHART.teal}
                  />
                ))
              )}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-3 text-[13px] font-medium">{T("overview.systemHealth")}</h3>
            {/* unified chips: same size, same StatusChip component, one data source */}
            <div className="flex flex-wrap gap-2">
              <StatusChip tone={health.data?.checks.db === "down" ? "error" : "ok"}>
                {T("overview.db")}: {health.data ? T(`health.${health.data.checks.db}`) : "…"}
              </StatusChip>
              <StatusChip tone={health.data?.checks.ws === "down" ? "error" : "ok"}>
                {T("overview.ws")}: {health.data ? T(`health.${health.data.checks.ws}`) : "…"}
              </StatusChip>
              <StatusChip tone={health.data?.checks.llm === "error" ? "error" : health.data?.checks.llm === "disabled" ? "muted" : "ok"}>
                {T("overview.llm")}: {""}
                {health.data ? (health.data.checks.llm === "ok" ? T("health.llmOk") : health.data.checks.llm === "disabled" ? T("health.disabled") : T("health.llmError")) : "…"}
              </StatusChip>
              <StatusChip tone="muted">
                {T("overview.queueDepth")}:{" "}
                <span dir="ltr" className="sg-num">
                  {health.data ? health.data.queue.depth : "—"}
                </span>
              </StatusChip>
              {health.data && (
                <StatusChip tone={health.data.status === "degraded" ? "warn" : "ok"}>
                  <span dir="ltr">{fmtUptime(health.data.uptimeSec)}</span>
                </StatusChip>
              )}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-2 flex items-center justify-between text-[13px] font-medium">
              {T("overview.recentIncidents")}
            </h3>
            {recentIncidents.isLoading ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{T("common.loading")}</p>
            ) : (recentIncidents.data?.data.length ?? 0) === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{T("overview.noRecentIncidents")}</p>
            ) : (
              <ul className="space-y-1 pe-1">
                {recentIncidents.data!.data.map((inc, i) => (
                  <motion.li
                    key={inc.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03, duration: 0.15 }}
                  >
                    <button
                      type="button"
                      onClick={() => openIncident(inc.id)}
                      title={`${inc.id} — ${inc.title}`}
                      className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-start transition-colors hover:border-border hover:bg-secondary/60"
                    >
                      <SeverityDot severity={inc.severity} className="mt-1" />
                      <span dir="ltr" className="sg-num shrink-0 text-[11px] text-muted-foreground">
                        {inc.id}
                      </span>
                      <span className="line-clamp-2 min-w-0 flex-1 break-words text-xs leading-snug">{inc.title}</span>
                      <IncidentStatusChip status={inc.status} className="hidden sm:inline-flex" />
                      <TimeAgo iso={inc.updatedAt} className="shrink-0 text-[10px] text-muted-foreground" />
                    </button>
                  </motion.li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
