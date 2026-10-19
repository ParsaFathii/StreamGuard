"use client";

// StreamGuard Console — Section 5: Detections.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { SEVERITIES, type Detection, type Severity } from "@/lib/types";
import { useUiStore } from "@/lib/store";
import {
  DetectionStatusChip,
  EmptyState,
  ErrorState,
  SEVERITY_UI,
  SectionHeader,
  SeverityBadge,
  SeverityDot,
  SkeletonTable,
  useT,
} from "../primitives";
import { JsonViewer } from "../json-viewer";
import { MonoTime } from "../time";
import { PaginationFooter } from "../pagination";

type TimeKey = "1h" | "6h" | "24h" | "7d";

export function DetectionsSection() {
  const T = useT();
  const openIncident = useUiStore((s) => s.openIncident);
  const [ruleId, setRuleId] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [linked, setLinked] = useState("all");
  const [time, setTime] = useState<TimeKey>("24h");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  const rules = useQuery({ queryKey: ["rules"], queryFn: api.rules, staleTime: 60_000 });

  const params = useMemo(() => {
    const mins = { "1h": 60, "6h": 360, "24h": 1440, "7d": 10080 }[time];
    return {
      ruleId: ruleId === "all" ? undefined : ruleId,
      severity: severity === "all" ? undefined : severity,
      from: new Date(Date.now() - mins * 60_000).toISOString(),
      page,
      pageSize,
    };
  }, [ruleId, severity, time, page, pageSize]);

  const detections = useQuery({
    queryKey: ["detections", "list", params],
    queryFn: () => api.detections(params),
    placeholderData: (prev) => prev,
  });

  const eventDetail = useQuery({
    queryKey: ["event", eventId],
    queryFn: () => api.event(eventId!),
    enabled: !!eventId,
  });

  const rows = detections.data?.data ?? [];
  const apply = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <SectionHeader title={T("detections.title")} desc={T("navDesc.detections")} />

      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3">
        <Select value={ruleId} onValueChange={(v) => apply(() => setRuleId(v))}>
          <SelectTrigger size="sm" className="h-8 w-44 text-xs" aria-label={T("detections.ruleFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">{T("detections.allRules")}</SelectItem>
            {(rules.data ?? []).map((r) => (
              <SelectItem key={r.id} value={r.id} className="font-mono text-xs">
                {r.id} · {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={severity} onValueChange={(v) => apply(() => setSeverity(v))}>
          <SelectTrigger size="sm" className="h-8 w-32 text-xs" aria-label={T("common.severity")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">{T(`sev.${s}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={linked} onValueChange={(v) => apply(() => setLinked(v))}>
          <SelectTrigger size="sm" className="h-8 w-32 text-xs" aria-label={T("detections.linkedFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
            <SelectItem value="linked" className="text-xs">{T("detections.linked")}</SelectItem>
            <SelectItem value="unlinked" className="text-xs">{T("detections.unlinked")}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={time} onValueChange={(v) => apply(() => setTime(v as TimeKey))}>
          <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label={T("events.timeRange")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1h" className="text-xs">{T("events.range1h")}</SelectItem>
            <SelectItem value="6h" className="text-xs">{T("events.range6h")}</SelectItem>
            <SelectItem value="24h" className="text-xs">{T("events.range24h")}</SelectItem>
            <SelectItem value="7d" className="text-xs">{T("events.range7d")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {detections.isError ? (
        <ErrorState message={(detections.error as Error)?.message} onRetry={() => detections.refetch()} />
      ) : detections.isLoading ? (
        <SkeletonTable rows={8} cols={7} />
      ) : rows.length === 0 ? (
        <EmptyState title={T("detections.emptyTitle")} hint={T("detections.emptyHint")} />
      ) : (
        <div className="rounded-md border border-border bg-card">
          <div className="overflow-x-auto">
            <Table className="sg-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className="w-8" aria-label={T("common.details")} />
                  <TableHead scope="col">{T("common.time")}</TableHead>
                  <TableHead scope="col">{T("detections.ruleFilter")}</TableHead>
                  <TableHead scope="col">{T("common.severity")}</TableHead>
                  <TableHead scope="col" className="hidden lg:table-cell">{T("correlation.groupKey")}</TableHead>
                  <TableHead scope="col" className="text-center">{T("detections.matched")}</TableHead>
                  <TableHead scope="col" className="w-28">{T("detections.score")}</TableHead>
                  <TableHead scope="col" className="hidden sm:table-cell">{T("common.status")}</TableHead>
                  <TableHead scope="col">{T("detections.linkedIncident")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows
                  .filter((d) => (linked === "all" ? true : linked === "linked" ? !!d.incidentId : !d.incidentId))
                  .map((d) => (
                    <DetectionRow
                      key={d.id}
                      d={d}
                      ruleName={rules.data?.find((r) => r.id === d.ruleId)?.name}
                      expanded={expanded === d.id}
                      onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
                      onOpenIncident={() => d.incidentId && openIncident(d.incidentId)}
                      onViewEvent={(id) => setEventId(id ?? d.eventId)}
                    />
                  ))}
              </TableBody>
            </Table>
          </div>
          <div className="px-2">
            <PaginationFooter
              page={detections.data?.page ?? page}
              pageSize={pageSize}
              total={detections.data?.total ?? 0}
              onPage={setPage}
              onPageSize={(s) => {
                setPageSize(s);
                setPage(1);
              }}
            />
          </div>
        </div>
      )}

      {/* event detail dialog */}
      <Dialog open={!!eventId} onOpenChange={(o) => !o && setEventId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {T("detections.viewTriggering")}
              {eventDetail.data && <SeverityBadge severity={eventDetail.data.severity} className="ms-2" />}
            </DialogTitle>
          </DialogHeader>
          {eventDetail.isLoading && !eventDetail.data ? (
            <SkeletonTable rows={3} cols={2} />
          ) : eventDetail.data ? (
            <div className="space-y-2">
              <p className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs">
                {eventDetail.data.message}
              </p>
              <JsonViewer value={eventDetail.data} maxHeight={320} />
            </div>
          ) : (
            <ErrorState onRetry={() => eventDetail.refetch()} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetectionRow({
  d,
  ruleName,
  expanded,
  onToggle,
  onOpenIncident,
  onViewEvent,
}: {
  d: Detection;
  ruleName?: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenIncident: () => void;
  onViewEvent: (eventId?: string) => void;
}) {
  const T = useT();
  const sev = SEVERITY_UI[d.severity as Severity];
  const score = Math.max(0, Math.min(1, d.score ?? 0));
  const keyLabel = d.detail.actor ?? d.detail.sourceId ?? "—";

  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell>
          <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <MonoTime iso={d.createdAt} className="text-muted-foreground" />
        </TableCell>
        <TableCell>
          <span dir="ltr" className="sg-num block text-[11px]">{d.ruleId}</span>
          {ruleName && <span className="block max-w-44 truncate text-[11px] text-muted-foreground">{ruleName}</span>}
        </TableCell>
        <TableCell>
          <SeverityBadge severity={d.severity} />
        </TableCell>
        <TableCell dir="ltr" className="hidden max-w-32 truncate font-mono text-[11px] text-muted-foreground lg:table-cell">
          {keyLabel}
        </TableCell>
        <TableCell className="text-center">
          <span dir="ltr" className="sg-num">{d.detail.matchedCount}</span>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full" style={{ width: `${Math.round(score * 100)}%`, background: sev.hex }} />
            </div>
            <span dir="ltr" className="sg-num text-[10px] text-muted-foreground">{score.toFixed(2)}</span>
          </div>
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <DetectionStatusChip status={d.status} />
        </TableCell>
        <TableCell>
          {d.incidentId ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenIncident();
              }}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-emerald-600 hover:underline dark:text-emerald-400"
            >
              {d.incidentId}
              <ExternalLink className="size-3" />
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">{T("detections.noIncident")}</span>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={9} className="bg-secondary/30 p-3">
            <div className="grid gap-3 text-xs sm:grid-cols-3">
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {T("detections.windowLabel")}
                </p>
                <p dir="ltr" className="sg-num">{d.detail.windowSeconds}s</p>
                <p className="mb-1 mt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {T("detections.matched")}
                </p>
                <p dir="ltr" className="sg-num">{d.detail.matchedCount}</p>
              </div>
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {T("detections.sampleEvents")}
                </p>
                <ul className="max-h-28 space-y-0.5 overflow-y-auto font-mono text-[10px]">
                  {(d.detail.sampleEventIds ?? []).map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onViewEvent(id);
                        }}
                        className="max-w-full truncate text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400"
                        title={id}
                      >
                        {id}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col items-start justify-start gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewEvent();
                  }}
                >
                  <SeverityDot severity={d.severity} /> {T("detections.viewTriggering")}
                </Button>
                {d.incidentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenIncident();
                    }}
                  >
                    {d.incidentId} → {T("investigate.title")}
                  </Button>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
