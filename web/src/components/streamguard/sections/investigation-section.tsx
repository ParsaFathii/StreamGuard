"use client";

// StreamGuard Console — Section 7: Incident Investigation workspace.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Loader2, Printer, Send, Sparkles, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api-client";
import type { IncidentStatus, SessionUser } from "@/lib/types";
import { isAnalystPlus, useUiStore } from "@/lib/store";
import {
  EmptyState,
  ErrorState,
  IncidentStatusChip,
  SectionHeader,
  SeverityBadge,
  SeverityDot,
  SkeletonTable,
  useT,
} from "../primitives";
import { JsonViewer } from "../json-viewer";
import { MonoTime, TimeAgo, fmtFull } from "../time";
import { AiReportView } from "../ai-report";
import { aiReportHtml, escapeHtml, printReport } from "../print";
import type { AiInvestigateResponse } from "@/lib/types";

const STATUS_FLOW: IncidentStatus[] = ["NEW", "TRIAGED", "INVESTIGATING", "RESOLVED", "CLOSED"];

const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  NEW: ["TRIAGED", "INVESTIGATING", "RESOLVED", "CLOSED"],
  TRIAGED: ["INVESTIGATING", "RESOLVED", "CLOSED"],
  INVESTIGATING: ["TRIAGED", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "INVESTIGATING"],
  CLOSED: ["INVESTIGATING"], // ADMIN reopen only
};

export function InvestigationSection({ user }: { user: SessionUser }) {
  const T = useT();
  const qc = useQueryClient();
  const preselected = useUiStore((s) => s.investigateIncidentId);
  const canEdit = isAnalystPlus(user.role);

  const incidents = useQuery({
    queryKey: ["incidents", "picker"],
    queryFn: () => api.incidents({ page: 1, pageSize: 100, sort: "createdAt" }),
  });

  const [incidentId, setIncidentId] = useState<string>("");
  const [note, setNote] = useState("");
  const [eventId, setEventId] = useState<string | null>(null);
  // AI report paired with the incident it belongs to (avoids reset effects)
  const [aiReportState, setAiReportState] = useState<{ id: string; res: AiInvestigateResponse | null }>({
    id: "",
    res: null,
  });
  const aiReport = aiReportState.id === incidentId ? aiReportState.res : null;
  // sync preselected incident from other sections (render-phase adjust)
  if (preselected && preselected !== incidentId) setIncidentId(preselected);

  const detail = useQuery({
    queryKey: ["incident", incidentId],
    queryFn: () => api.incident(incidentId),
    enabled: !!incidentId,
  });

  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 120_000 });

  const eventDetail = useQuery({
    queryKey: ["event", eventId],
    queryFn: () => api.event(eventId!),
    enabled: !!eventId,
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.patchIncident>[1] }) =>
      api.patchIncident(id, patch),
    onSuccess: (_d, { id }) => {
      toast.success(T("toasts.incidentUpdated", { id }));
      qc.invalidateQueries({ queryKey: ["incidents"] });
      qc.invalidateQueries({ queryKey: ["incident", id] });
    },
    onError: (err: Error, { id }) => {
      const ae = err as ApiError;
      toast.error(
        ae.status === 403
          ? T("toasts.forbidden")
          : ae.code === "INVALID_TRANSITION"
            ? T("toasts.invalidTransition")
            : T("toasts.incidentUpdateFailed", { id }),
      );
    },
  });

  const noteMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api.addNote(id, body),
    onSuccess: () => {
      toast.success(T("toasts.noteAdded"));
      setNote("");
      qc.invalidateQueries({ queryKey: ["incident", incidentId] });
      qc.invalidateQueries({ queryKey: ["incidents"] });
    },
    onError: (err: Error) =>
      toast.error((err as ApiError).status === 403 ? T("toasts.forbidden") : T("toasts.noteFailed")),
  });

  const aiMutation = useMutation({
    mutationFn: (q?: string) => api.aiInvestigate(incidentId, q),
    onSuccess: (res) => {
      setAiReportState({ id: incidentId, res });
      toast.success(T("toasts.aiGenerated", { ms: res.durationMs }));
      qc.invalidateQueries({ queryKey: ["incident", incidentId] });
    },
    onError: (err: Error) => {
      const ae = err as ApiError;
      toast.error(
        ae.status === 503 ? `${T("toasts.aiFailed")}: ${ae.message}` : ae.status === 403 ? T("toasts.forbidden") : T("toasts.aiFailed"),
      );
    },
  });

  const inc = detail.data;
  const aiEnabled = settings.data?.aiEnabled ?? false;

  // Printable incident report — full case file: summary, timeline, notes,
  // linked evidence and (when present) the AI analysis block.
  const printIncident = () => {
    if (!inc) return;
    const evs = inc.events.slice(0, 100);
    const evNote =
      inc.events.length > evs.length
        ? `<p class="muted">${escapeHtml(T("print.fShowing", { a: evs.length, b: inc.events.length }))}</p>`
        : "";
    const body =
      `<h2>${escapeHtml(T("print.summary"))}</h2>` +
      `<table><tbody>` +
      `<tr><th>ID</th><td class="mono">${escapeHtml(inc.id)}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fSeverity"))}</th><td>${escapeHtml(inc.severity)}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fStatus"))}</th><td>${escapeHtml(inc.status)}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fRule"))}</th><td class="mono">${escapeHtml(inc.ruleId)}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fCorrelation"))}</th><td class="mono">${escapeHtml(inc.correlationLabel)} (${escapeHtml(inc.correlationKey)})</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fAssignee"))}</th><td>${escapeHtml(inc.assignedTo ?? "—")}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fEvents"))}</th><td class="mono num">${inc.eventCount}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fDetections"))}</th><td class="mono num">${inc.detectionCount}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fFirstEvent"))}</th><td class="mono">${escapeHtml(inc.firstEventTime ?? "—")}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fLastEvent"))}</th><td class="mono">${escapeHtml(inc.lastEventTime ?? "—")}</td></tr>` +
      `<tr><th>${escapeHtml(T("print.fCreated"))}</th><td class="mono">${escapeHtml(inc.createdAt)}</td></tr>` +
      (inc.resolutionSummary
        ? `<tr><th>${escapeHtml(T("print.fResolution"))}</th><td>${escapeHtml(inc.resolutionSummary)}</td></tr>`
        : "") +
      `</tbody></table>` +
      `<h2>${escapeHtml(T("print.timeline"))}</h2>` +
      `<table><thead><tr><th>${escapeHtml(T("print.fFrom"))}</th><th>${escapeHtml(T("print.fTo"))}</th><th>${escapeHtml(T("print.fActor"))}</th><th class="num">${escapeHtml(T("print.fTime"))}</th></tr></thead><tbody>` +
      inc.statusHistory
        .map(
          (h) =>
            `<tr><td>${escapeHtml(h.fromStatus ?? "—")}</td><td>${escapeHtml(h.toStatus)}</td><td>${escapeHtml(h.actor)}</td><td class="mono">${escapeHtml(h.ts)}</td></tr>`,
        )
        .join("") +
      `</tbody></table>` +
      `<h2>${escapeHtml(T("print.notes"))}</h2>` +
      (inc.notes.length
        ? `<ul>${inc.notes
            .map((n) => `<li><span class="mono">${escapeHtml(n.createdAt)}</span> — <b>${escapeHtml(n.author)}</b>: ${escapeHtml(n.body)}</li>`)
            .join("")}</ul>`
        : `<p class="muted">—</p>`) +
      `<h2>${escapeHtml(T("print.linkedEvents"))}</h2>` +
      evNote +
      `<table><thead><tr><th>${escapeHtml(T("print.fTime"))}</th><th>${escapeHtml(T("print.fSource"))}</th><th>${escapeHtml(T("print.fSeverity"))}</th><th>${escapeHtml(T("print.fCategory"))}</th><th>${escapeHtml(T("print.fActor"))}</th><th>${escapeHtml(T("print.fMessage"))}</th></tr></thead><tbody>` +
      evs
        .map(
          (e) =>
            `<tr><td class="mono">${escapeHtml(e.eventTime)}</td><td class="mono">${escapeHtml(e.sourceId)}</td><td>${escapeHtml(e.severity)}</td><td>${escapeHtml(e.category)}</td><td>${escapeHtml(e.actor ?? "—")}</td><td>${escapeHtml(e.message)}</td></tr>`,
        )
        .join("") +
      `</tbody></table>` +
      `<h2>${escapeHtml(T("print.linkedDetections"))}</h2>` +
      (inc.detections.length
        ? `<table><thead><tr><th>${escapeHtml(T("print.fRule"))}</th><th>${escapeHtml(T("print.fSeverity"))}</th><th>${escapeHtml(T("print.fTitle"))}</th><th class="num">${escapeHtml(T("print.fTime"))}</th></tr></thead><tbody>` +
          inc.detections
            .map(
              (d) =>
                `<tr><td class="mono">${escapeHtml(d.ruleId)}</td><td>${escapeHtml(d.severity)}</td><td>${escapeHtml(d.title)}</td><td class="mono">${escapeHtml(d.createdAt)}</td></tr>`,
            )
            .join("") +
          `</tbody></table>`
        : `<p class="muted">—</p>`) +
      (aiReport
        ? `<h2>${escapeHtml(T("print.aiReport"))}</h2>` +
          aiReportHtml(aiReport, {
            summary: T("aiBlocks.summary"),
            facts: T("aiBlocks.facts"),
            ruleFindings: T("aiBlocks.ruleFindings"),
            mlFindings: T("aiBlocks.mlFindings"),
            hypotheses: T("aiBlocks.hypotheses"),
            nextSteps: T("aiBlocks.nextSteps"),
            references: T("aiBlocks.references"),
            events: T("aiBlocks.events"),
            incident: T("aiBlocks.incident"),
            rules: T("print.rules"),
            provider: T("print.provider"),
          })
        : "");
    printReport(
      {
        title: `${T("print.incidentReport")} — ${inc.title}`,
        subtitle: `${inc.id} · ${inc.ruleId} · ${inc.correlationLabel}`,
        by: `${user.displayName} @${user.username}`,
        labels: {
          generatedBy: T("print.generatedBy"),
          generatedAt: T("print.generatedAt"),
          confidential: T("print.confidential"),
        },
        bodyHtml: body,
      },
      T("print.blocked"),
    );
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={T("investigate.title")}
        desc={T("navDesc.investigate")}
        actions={
          inc ? (
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={printIncident}>
              <Printer className="size-3.5" /> {T("print.button")}
            </Button>
          ) : undefined
        }
      />

      {/* incident picker */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3">
        <span className="text-xs font-medium text-muted-foreground">{T("investigate.pickIncident")}</span>
        <Select value={incidentId} onValueChange={setIncidentId}>
          <SelectTrigger size="sm" className="h-8 min-w-64 flex-1 text-xs sm:max-w-md" aria-label={T("investigate.pickIncident")}>
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
        {inc && (
          <div className="flex items-center gap-2">
            <SeverityBadge severity={inc.severity} />
            <IncidentStatusChip status={inc.status} />
          </div>
        )}
      </div>

      {!incidentId ? (
        <EmptyState title={T("investigate.title")} hint={T("investigate.noIncidentSelected")} />
      ) : detail.isError ? (
        <ErrorState message={(detail.error as Error)?.message} onRetry={() => detail.refetch()} />
      ) : detail.isLoading || !inc ? (
        <SkeletonTable rows={6} cols={3} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* left: event timeline */}
          <section aria-label={T("investigate.timeline")} className="rounded-md border border-border bg-card p-3 lg:col-span-3">
            <h3 className="mb-2 flex items-center justify-between text-[13px] font-medium">
              {T("investigate.timeline")}
              <span dir="ltr" className="sg-num text-[10px] text-muted-foreground">{inc.events.length}</span>
            </h3>
            <p className="mb-2 text-[10px] text-muted-foreground">{T("investigate.timelineHint")}</p>
            <ol className="relative max-h-[calc(100dvh-380px)] space-y-1 overflow-y-auto border-s border-border ps-3">
              {inc.events
                .slice()
                .sort((a, b) => a.eventTime.localeCompare(b.eventTime))
                .map((ev, idx, arr) => {
                  const prev = arr[idx - 1];
                  const newGroup = !prev || prev.correlationId !== ev.correlationId;
                  return (
                    <li key={ev.id}>
                      {newGroup && ev.correlationId && (
                        <p dir="ltr" className="mb-1 mt-2 truncate font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70" title={ev.correlationId}>
                          ─ {ev.correlationId}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => setEventId(ev.id)}
                        className="group flex w-full items-start gap-2 rounded px-1.5 py-1 text-start transition-colors hover:bg-secondary/60"
                      >
                        <SeverityDot severity={ev.severity} className="mt-1.5" />
                        <span className="min-w-0 flex-1">
                          <MonoTime iso={ev.eventTime} className="block text-[10px] text-muted-foreground" />
                          <span className="block truncate text-[11px] group-hover:text-foreground">{ev.message}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              {inc.events.length === 0 && (
                <li className="py-4 text-center text-xs text-muted-foreground">{T("states.empty")}</li>
              )}
            </ol>
          </section>

          {/* middle: meta + lifecycle + notes + AI */}
          <section aria-label={inc.title} className="space-y-4 lg:col-span-5">
            <div className="rounded-md border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold leading-snug">{inc.title}</h3>
                  <p dir="ltr" className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    {inc.ruleId} · {inc.correlationLabel}: {inc.correlationKey}
                  </p>
                </div>
                <div className="text-end font-mono text-[10px] text-muted-foreground">
                  <p dir="ltr">{inc.eventCount} {T("common.events")} · {inc.detectionCount} {T("common.detections")}</p>
                  <p>{T("common.time")}: <TimeAgo iso={inc.createdAt} /></p>
                </div>
              </div>

              {/* status stepper */}
              <div className="mt-4" aria-label={T("investigate.statusStepper")}>
                <div className="flex items-center">
                  {STATUS_FLOW.map((s, i) => {
                    const currentIdx = STATUS_FLOW.indexOf(inc.status);
                    const done = i < currentIdx;
                    const current = i === currentIdx;
                    return (
                      <div key={s} className="flex flex-1 items-center last:flex-none">
                        <div className="flex flex-col items-center gap-1">
                          <span
                            aria-hidden
                            className={`flex size-4 items-center justify-center rounded-full border text-[8px] font-bold ${
                              current
                                ? "border-primary bg-primary text-primary-foreground"
                                : done
                                  ? "border-primary/60 bg-primary/20 text-emerald-700 dark:text-emerald-400"
                                  : "border-border bg-secondary text-muted-foreground"
                            } ${current ? "sg-pulse" : ""}`}
                          >
                            {done ? "✓" : i + 1}
                          </span>
                          <span className={`whitespace-nowrap text-[9px] ${current ? "font-semibold text-primary" : "text-muted-foreground"}`}>
                            {T(`incStatus.${s}`)}
                          </span>
                        </div>
                        {i < STATUS_FLOW.length - 1 && (
                          <div className={`mx-1 h-px flex-1 ${i < currentIdx ? "bg-primary/50" : "bg-border"}`} />
                        )}
                      </div>
                    );
                  })}
                </div>

                {canEdit && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{T("investigate.moveTo")}:</span>
                    {(TRANSITIONS[inc.status] ?? [])
                      .filter((s) => !(inc.status === "CLOSED" && s === "INVESTIGATING" && user.role !== "ADMIN"))
                      .map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant={s === "RESOLVED" ? "default" : "outline"}
                          className="h-7 px-2 text-[11px]"
                          disabled={patchMutation.isPending}
                          onClick={() => patchMutation.mutate({ id: inc.id, patch: { status: s } })}
                        >
                          {T(`incStatus.${s}`)}
                        </Button>
                      ))}
                    {inc.assignedTo === null && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        disabled={patchMutation.isPending}
                        onClick={() => patchMutation.mutate({ id: inc.id, patch: { assignedTo: user.username } })}
                      >
                        <UserPlus className="size-3" /> {T("incidents.assignToMe")}
                      </Button>
                    )}
                    {inc.assignedTo && (
                      <span className="ms-auto font-mono text-[10px] text-muted-foreground">
                        {T("incidents.assignee")}: <span dir="ltr">{inc.assignedTo}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>

              {inc.resolutionSummary && (
                <p className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs">
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">{T("incidents.summaryLabel")}: </span>
                  {inc.resolutionSummary}
                </p>
              )}
            </div>

            {/* notes */}
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-2 text-[13px] font-medium">{T("investigate.notes")}</h3>
              {inc.notes.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">{T("investigate.noNotes")}</p>
              ) : (
                <ul className="mb-3 max-h-48 space-y-2 overflow-y-auto pe-1">
                  {inc.notes.map((n) => (
                    <li key={n.id} className="rounded-md border border-border/70 bg-secondary/30 px-2.5 py-2">
                      <p className="whitespace-pre-wrap text-xs leading-relaxed">{n.body}</p>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground" dir="ltr">
                        {n.author} · {fmtFull(n.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && (
                <div className="space-y-1.5">
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={T("investigate.notePlaceholder")}
                    className="min-h-16 text-xs"
                    maxLength={4000}
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-7"
                      disabled={!note.trim() || noteMutation.isPending}
                      onClick={() => noteMutation.mutate({ id: inc.id, body: note.trim() })}
                    >
                      {noteMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                      {noteMutation.isPending ? T("investigate.posting") : T("investigate.post")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* AI report panel */}
            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
                  <Sparkles className="size-4 text-emerald-600 dark:text-emerald-400" /> {T("investigate.aiPanel")}
                </h3>
                {canEdit && aiEnabled && (
                  <Button size="sm" className="h-7" disabled={aiMutation.isPending} onClick={() => aiMutation.mutate(undefined)}>
                    {aiMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    {aiMutation.isPending ? T("common.generating") : T("investigate.generate")}
                  </Button>
                )}
              </div>

              {aiReport ? (
                <AiReportView res={aiReport} />
              ) : aiMutation.isPending ? (
                <div className="space-y-2">
                  <SkeletonTable rows={3} cols={1} />
                </div>
              ) : !canEdit ? (
                <EmptyState className="border-none py-6" title={T("investigate.aiViewerHint")} />
              ) : !aiEnabled ? (
                <div className="rounded-md border border-dashed border-border px-3 py-5 text-center">
                  <p className="text-xs font-medium text-muted-foreground">{T("investigate.aiDisabledTitle")}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/80">{T("investigate.aiDisabledHint")}</p>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">{T("ai.evidenceHint")}</p>
              )}

              {inc.aiReports.length > 0 && (
                <div className="mt-3 border-t border-border pt-2">
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {T("investigate.reportHistory")}
                  </p>
                  <ul className="space-y-0.5">
                    {inc.aiReports.map((r) => (
                      <li key={r.id} className="flex items-center justify-between font-mono text-[10px] text-muted-foreground" dir="ltr">
                        <span>{r.id.slice(0, 18)}…</span>
                        <span>{fmtFull(r.ts)} · {r.providerStatus}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>

          {/* right: detections + status history + export */}
          <section aria-label={T("investigate.linkedDetections")} className="space-y-4 lg:col-span-4">
            <div className="rounded-md border border-border bg-card p-3">
              <h3 className="mb-2 text-[13px] font-medium">{T("investigate.linkedDetections")}</h3>
              {inc.detections.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground">{T("states.empty")}</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto pe-1">
                  {inc.detections.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-[11px]">
                      <SeverityDot severity={d.severity} />
                      <span dir="ltr" className="sg-num w-24 shrink-0">{d.ruleId}</span>
                      <MonoTime iso={d.createdAt} className="w-16 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{d.title}</span>
                      <span dir="ltr" className="sg-num shrink-0 text-muted-foreground">{(d.score ?? 0).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-md border border-border bg-card p-3">
              <h3 className="mb-2 text-[13px] font-medium">{T("investigate.statusHistory")}</h3>
              <ol className="relative space-y-2 border-s border-border ps-3">
                {inc.statusHistory.map((h, i) => (
                  <li key={i} className="text-[11px]">
                    <p dir="ltr" className="sg-num text-muted-foreground">{fmtFull(h.ts)}</p>
                    <p>
                      {h.fromStatus ? `${h.fromStatus} → ` : ""}
                      <span className="font-medium">{h.toStatus}</span>{" "}
                      <span className="text-muted-foreground">
                        {T("investigate.by")} {h.actor}
                      </span>
                    </p>
                    {h.note && <p className="text-muted-foreground">{h.note}</p>}
                  </li>
                ))}
              </ol>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                const blob = new Blob([JSON.stringify(inc, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${inc.id}-evidence.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success(T("toasts.exported"));
              }}
            >
              <Download className="size-3.5" /> {T("investigate.exportEvidence")}
            </Button>
            <p className="text-[10px] text-muted-foreground">{T("investigate.evidenceBundle")}</p>
          </section>
        </div>
      )}

      {/* event detail dialog (timeline clicks) */}
      <Dialog open={!!eventId} onOpenChange={(o) => !o && setEventId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">{T("events.eventDetail")}</DialogTitle>
          </DialogHeader>
          {eventDetail.isLoading && !eventDetail.data ? (
            <SkeletonTable rows={3} cols={2} />
          ) : eventDetail.data ? (
            <JsonViewer value={eventDetail.data} maxHeight={380} />
          ) : (
            <ErrorState onRetry={() => eventDetail.refetch()} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
