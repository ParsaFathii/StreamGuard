"use client";

// StreamGuard Console — Section 12: System Health.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, Database, HeartPulse, Loader2, Radio, Sparkles, Timer, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import type { SessionUser } from "@/lib/types";
import { isAdmin } from "@/lib/store";
import {
  ErrorState,
  SectionHeader,
  SkeletonCards,
  StatusChip,
  useT,
} from "../primitives";
import { fmtFull, fmtUptime, TimeAgo } from "../time";

/** Minimal Prometheus text highlighter (no external deps). */
function MetricsText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre dir="ltr" className="sg-num max-h-96 overflow-auto rounded-md border border-border bg-[#0C110F] p-3 font-mono text-[10.5px] leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith("#")) {
          return (
            <div key={i} className="text-muted-foreground/60">
              {line}
            </div>
          );
        }
        const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
        if (m) {
          return (
            <div key={i}>
              <span className="text-emerald-600 dark:text-emerald-400">{m[1]}</span>
              {m[2] && <span className="text-amber-700/90 dark:text-amber-300/90">{m[2]}</span>}{" "}
              <span className="text-teal-700 dark:text-teal-300">{m[3]}</span>
            </div>
          );
        }
        return <div key={i}>{line || "\u00A0"}</div>;
      })}
    </pre>
  );
}

export function HealthSection({ user }: { user: SessionUser }) {
  const T = useT();
  const qc = useQueryClient();
  const admin = isAdmin(user.role);

  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.analyticsOverview, refetchInterval: 30_000 });
  const metrics = useQuery({
    queryKey: ["metrics"],
    queryFn: api.metricsText,
    refetchInterval: 60_000,
    staleTime: 45_000,
  });

  const retentionMutation = useMutation({
    mutationFn: () => api.retentionRun(),
    onSuccess: (res) => {
      toast.success(T("toasts.retentionDone", { n: res.deletedCount ?? 0 }));
      qc.invalidateQueries({ queryKey: ["health"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err: Error) =>
      toast.error((err as ApiError).status === 403 ? T("toasts.forbidden") : T("toasts.retentionFailed")),
  });

  if (health.isError) {
    return (
      <div className="space-y-4">
        <SectionHeader title={T("health.title")} desc={T("navDesc.health")} />
        <ErrorState message={(health.error as Error)?.message} onRetry={() => health.refetch()} />
      </div>
    );
  }

  const h = health.data;

  const checks = [
    {
      name: T("health.db"),
      icon: Database,
      ok: h?.checks.db === "up",
      label: h ? T(`health.${h.checks.db}`) : "…",
    },
    {
      name: T("health.ws"),
      icon: Radio,
      ok: h?.checks.ws === "up",
      label: h ? T(`health.${h.checks.ws}`) : "…",
    },
    {
      name: T("health.llm"),
      icon: Sparkles,
      ok: h?.checks.llm === "ok",
      warn: h?.checks.llm === "disabled",
      label: h
        ? h.checks.llm === "ok"
          ? T("health.llmOk")
          : h.checks.llm === "disabled"
            ? T("health.disabled")
            : T("health.llmError")
        : "…",
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title={T("health.title")}
        desc={T("navDesc.health")}
        actions={
          <StatusChip tone={h?.status === "ok" ? "ok" : "warn"}>
            <HeartPulse className="size-3" />
            {h ? (h.status === "ok" ? T("health.statusOk") : T("health.statusDegraded")) : "…"}
          </StatusChip>
        }
      />

      {health.isLoading || !h ? (
        <SkeletonCards count={4} />
      ) : (
        <>
          {/* checks grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {checks.map((c) => (
              <div key={c.name} className="rounded-md border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <c.icon className="size-4 text-muted-foreground" /> {c.name}
                  </span>
                  <StatusChip tone={c.ok ? "ok" : c.warn ? "muted" : "error"}>{c.label}</StatusChip>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {/* queue panel */}
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-[13px] font-medium">
                <Activity className="size-4 text-muted-foreground" /> {T("health.queue")}
              </h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <dt className="text-muted-foreground">{T("health.depth")}</dt>
                <dd dir="ltr" className="sg-num text-end font-semibold">{h.queue.depth}</dd>
                <dt className="text-muted-foreground">{T("health.processed24h")}</dt>
                <dd dir="ltr" className="sg-num text-end">{h.queue.processed24h.toLocaleString("en-US")}</dd>
                <dt className="text-muted-foreground">{T("health.rejected24h")}</dt>
                <dd dir="ltr" className="sg-num text-end text-rose-600 dark:text-rose-400">{h.queue.rejected24h.toLocaleString("en-US")}</dd>
                <dt className="text-muted-foreground">{T("health.avgLatency")}</dt>
                <dd dir="ltr" className="sg-num text-end">
                  {overview.data ? Math.round(overview.data.processing.avgLatencyMs24h ?? 0) : "—"} ms
                </dd>
                <dt className="text-muted-foreground">{T("health.p95Latency")}</dt>
                <dd dir="ltr" className="sg-num text-end">
                  {overview.data ? Math.round(overview.data.processing.p95LatencyMs24h ?? 0) : "—"} ms
                </dd>
              </dl>
            </div>

            {/* retention */}
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-[13px] font-medium">
                <Timer className="size-4 text-muted-foreground" /> {T("health.retention")}
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{T("health.policy")}</dt>
                  <dd dir="ltr" className="sg-num font-mono">{h.retention.policy}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{T("health.lastRun")}</dt>
                  <dd>
                    {h.retention.lastRunAt ? (
                      <span title={fmtFull(h.retention.lastRunAt)}>
                        <TimeAgo iso={h.retention.lastRunAt} />
                      </span>
                    ) : (
                      T("common.never")
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{T("health.deletedCount")}</dt>
                  <dd dir="ltr" className="sg-num">{h.retention.deletedCount}</dd>
                </div>
              </dl>
              <p className="mt-3 text-[10px] text-muted-foreground">{T("health.nonClosedProtected")}</p>
              {admin ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 h-7 w-full"
                  disabled={retentionMutation.isPending}
                  onClick={() => retentionMutation.mutate()}
                >
                  {retentionMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  {T("health.runNow")}
                </Button>
              ) : (
                <p className="mt-3 text-center text-[10px] text-muted-foreground">{T("health.viewerHint")}</p>
              )}
            </div>

            {/* uptime + version */}
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-3 text-[13px] font-medium">{T("health.version")}</h3>
              <dl className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{T("health.version")}</dt>
                  <dd dir="ltr" className="sg-num font-semibold text-emerald-600 dark:text-emerald-400">{h.version}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{T("health.uptime")}</dt>
                  <dd>{fmtUptime(h.uptimeSec)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{T("overview.lastProcessed")}</dt>
                  <dd>
                    {overview.data?.processing.lastProcessedAt ? (
                      <TimeAgo iso={overview.data.processing.lastProcessedAt} />
                    ) : (
                      T("common.never")
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* metrics preview */}
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-2 text-[13px] font-medium">{T("health.metricsPreview")}</h3>
            {metrics.isLoading ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{T("common.loading")}</p>
            ) : metrics.isError ? (
              <ErrorState message={(metrics.error as Error)?.message} onRetry={() => metrics.refetch()} />
            ) : (
              <MetricsText text={String(metrics.data ?? "")} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
