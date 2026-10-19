"use client";

// StreamGuard Console — Section 10: AI Investigation Assistant (standalone).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Send, ShieldAlert, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api, ApiError } from "@/lib/api-client";
import type { AiInvestigateResponse, SessionUser } from "@/lib/types";
import { isAnalystPlus } from "@/lib/store";
import {
  EmptyState,
  ErrorState,
  SectionHeader,
  SkeletonTable,
  StatusChip,
  useT,
} from "../primitives";
import { AiReportView } from "../ai-report";
import { fmtFull } from "../time";

export function AiSection({ user }: { user: SessionUser }) {
  const T = useT();
  const qc = useQueryClient();
  const canUse = isAnalystPlus(user.role);

  const [incidentId, setIncidentId] = useState<string>("");
  const [question, setQuestion] = useState("");
  // report is paired with the incident it was generated for (avoids effects)
  const [reportState, setReportState] = useState<{ id: string; report: AiInvestigateResponse | null }>({
    id: "",
    report: null,
  });
  const report = reportState.id === incidentId ? reportState.report : null;

  const pickIncident = (id: string) => {
    setIncidentId(id);
    setQuestion("");
    setReportState({ id, report: null });
  };

  const incidents = useQuery({
    queryKey: ["incidents", "picker"],
    queryFn: () => api.incidents({ page: 1, pageSize: 100, sort: "createdAt" }),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 120_000 });
  const detail = useQuery({
    queryKey: ["incident", incidentId],
    queryFn: () => api.incident(incidentId),
    enabled: !!incidentId,
  });
  const ml = useQuery({ queryKey: ["ml"], queryFn: api.ml, staleTime: 60_000 });

  const aiMutation = useMutation({
    mutationFn: (q?: string) => api.aiInvestigate(incidentId, q),
    onSuccess: (res) => {
      setReportState({ id: incidentId, report: res });
      toast.success(T("toasts.aiGenerated", { ms: res.durationMs }));
      qc.invalidateQueries({ queryKey: ["incident", incidentId] });
    },
    onError: (err: Error) => {
      const ae = err as ApiError;
      toast.error(
        ae.status === 503
          ? `${T("toasts.aiFailed")}: ${ae.message}`
          : ae.status === 403
            ? T("toasts.forbidden")
            : T("toasts.aiFailed"),
      );
    },
  });

  const aiEnabled = settings.data?.aiEnabled ?? false;
  const mlStatus = (ml.data?.currentBaselines ?? []).reduce(
    (acc, b) => ({ ...acc, [b.status]: (acc[b.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  return (
    <div className="space-y-4">
      <SectionHeader
        title={T("ai.title")}
        desc={T("navDesc.ai")}
        actions={
          <div className="flex items-center gap-2">
            <StatusChip tone={aiEnabled ? "ok" : "muted"}>
              {T("ai.provider")}: {settings.data?.aiProvider ?? "…"} ·{" "}
              {aiEnabled ? T("ai.providerStatus.ok") : T("ai.providerStatus.disabled")}
            </StatusChip>
          </div>
        }
      />

      {/* safety notice */}
      <Alert className="border-amber-400/30 bg-amber-400/5">
        <ShieldAlert className="size-4 text-amber-600 dark:text-amber-300" />
        <AlertTitle className="text-xs font-semibold text-amber-700 dark:text-amber-300">{T("ai.safetyTitle")}</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">{T("ai.safetyBody")}</AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* left: picker + context */}
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-card p-3">
            <Label className="mb-1.5 block text-xs">{T("ai.pickIncident")}</Label>
            <Select value={incidentId} onValueChange={pickIncident}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label={T("ai.pickIncident")}>
                <SelectValue placeholder={T("investigate.pickPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {(incidents.data?.data ?? []).map((i) => (
                  <SelectItem key={i.id} value={i.id} className="text-xs">
                    <span dir="ltr" className="sg-num">{i.id}</span> · {i.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {incidentId && (
            <div className="rounded-md border border-border bg-card p-3">
              <h3 className="mb-2 text-[13px] font-medium">{T("ai.context")}</h3>
              {detail.isLoading && !detail.data ? (
                <SkeletonTable rows={3} cols={1} />
              ) : detail.data ? (
                <ul className="space-y-1.5 text-xs">
                  <li>{T("ai.contextEvents", { n: detail.data.events.length })}</li>
                  <li dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                    {T("ai.contextRules", { id: detail.data.ruleId })}
                  </li>
                  <li>
                    <span dir="ltr" className="sg-num">{detail.data.detections.length}</span>{" "}
                    {T("ai.contextDetections", { n: detail.data.detections.length })}
                  </li>
                  <li className="text-[11px] text-muted-foreground">
                    {T("ai.contextMl", {
                      normal: mlStatus.normal ?? 0,
                      elevated: mlStatus.elevated ?? 0,
                      anomalous: mlStatus.anomalous ?? 0,
                    })}
                  </li>
                </ul>
              ) : (
                <ErrorState onRetry={() => detail.refetch()} />
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{T("ai.evidenceHint")}</p>
            </div>
          )}

          {/* history */}
          {incidentId && detail.data && detail.data.aiReports.length > 0 && (
            <div className="rounded-md border border-border bg-card p-3">
              <h3 className="mb-2 text-[13px] font-medium">{T("ai.history")}</h3>
              <ul className="space-y-1">
                {detail.data.aiReports.map((r) => (
                  <li key={r.id} className="flex items-center justify-between font-mono text-[10px] text-muted-foreground" dir="ltr">
                    <span>{r.id.slice(0, 18)}…</span>
                    <span>{fmtFull(r.ts)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* right: generator + report */}
        <div className="lg:col-span-2">
          <div className="rounded-md border border-border bg-card p-4">
            {!canUse ? (
              <EmptyState title={T("investigate.aiViewerHint")} className="border-none" />
            ) : !aiEnabled ? (
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
                <Sparkles className="mx-auto mb-2 size-5 text-muted-foreground/50" />
                <p className="text-xs font-medium text-muted-foreground">{T("investigate.aiDisabledTitle")}</p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">{T("investigate.aiDisabledHint")}</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor="ai-question" className="text-xs">
                      {T("ai.question")} <span className="text-muted-foreground">({T("common.optional")})</span>
                    </Label>
                    <Input
                      id="ai-question"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder={T("ai.questionPlaceholder")}
                      className="h-8 text-xs"
                    />
                  </div>
                  <Button
                    className="h-8 shrink-0"
                    disabled={!incidentId || aiMutation.isPending}
                    onClick={() => aiMutation.mutate(question.trim() || undefined)}
                  >
                    {aiMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                    {aiMutation.isPending ? T("common.generating") : T("ai.generate")}
                  </Button>
                </div>

                {!incidentId ? (
                  <EmptyState title={T("ai.title")} hint={T("ai.noIncident")} className="border-none" />
                ) : report ? (
                  <div className="pt-2">
                    <AiReportView res={report} />
                  </div>
                ) : aiMutation.isPending ? (
                  <SkeletonTable rows={4} cols={1} />
                ) : aiMutation.isError ? (
                  <ErrorState
                    message={`${T("ai.failedTitle")} — ${T("ai.failedBody")}`}
                    onRetry={() => aiMutation.mutate(question.trim() || undefined)}
                  />
                ) : (
                  <p className="text-[11px] text-muted-foreground">{T("ai.evidenceHint")}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
