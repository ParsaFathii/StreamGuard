"use client";

// StreamGuard Console — Section 2: Event Explorer.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, exportPath, IS_CONSOLE_EDITION } from "@/lib/api-client";
import { CATEGORIES, SEVERITIES, SOURCE_TYPES, type SgEvent, type Severity } from "@/lib/types";
import { useUiStore } from "@/lib/store";
import { ExportMenu } from "../export-menu";
import {
  EmptyState,
  ErrorState,
  EventStatusChip,
  OriginBadge,
  SEVERITY_UI,
  SectionHeader,
  SeverityBadge,
  SeverityDot,
  SkeletonTable,
  useT,
} from "../primitives";
import { JsonViewer } from "../json-viewer";
import { MonoTime, TimeAgo } from "../time";
import { PaginationFooter } from "../pagination";

type RangeKey = "15m" | "1h" | "6h" | "24h" | "7d" | "custom" | "all";

interface EventFilters {
  q: string;
  severities: Severity[];
  category: string;
  sourceId: string;
  sourceType: string;
  range: RangeKey;
  from: string;
  to: string;
  status: string;
  origin: string;
  page: number;
  pageSize: number;
}

const EMPTY_FILTERS: EventFilters = {
  q: "",
  severities: [],
  category: "all",
  sourceId: "all",
  sourceType: "all",
  range: "24h",
  from: "",
  to: "",
  status: "all",
  origin: "all",
  page: 1,
  pageSize: 25,
};

function rangeToISO(range: RangeKey, from: string, to: string): { from?: string; to?: string } {
  if (range === "all") return {};
  if (range === "custom") {
    return {
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    };
  }
  const mins = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440, "7d": 10080 }[range] ?? 1440;
  return { from: new Date(Date.now() - mins * 60_000).toISOString() };
}

export function EventExplorerSection() {
  const T = useT();
  const focusFlag = useUiStore((s) => s.focusEventsSearch);
  const clearFocus = useUiStore((s) => s.setFocusEventsSearch);
  const searchRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<EventFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<EventFilters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    if (focusFlag) {
      searchRef.current?.focus();
      clearFocus(false);
    }
  }, [focusFlag, clearFocus]);

  const sources = useQuery({ queryKey: ["sources"], queryFn: api.sources, staleTime: 60_000 });

  const queryParams = useMemo(() => {
    const { from, to } = rangeToISO(applied.range, applied.from, applied.to);
    return {
      q: applied.q.trim().length >= 2 ? applied.q.trim() : undefined,
      severity: applied.severities.length ? applied.severities : undefined,
      category: applied.category === "all" ? undefined : applied.category,
      sourceId: applied.sourceId === "all" ? undefined : applied.sourceId,
      sourceType: applied.sourceType === "all" ? undefined : applied.sourceType,
      status: applied.status === "all" ? undefined : applied.status,
      origin: applied.origin === "all" ? undefined : applied.origin,
      from,
      to,
      page: applied.page,
      pageSize: applied.pageSize,
    };
  }, [applied]);

  const events = useQuery({
    queryKey: ["events", "explorer", queryParams],
    queryFn: () => api.events(queryParams),
    placeholderData: (prev) => prev,
  });

  const detail = useQuery({
    queryKey: ["event", detailId],
    queryFn: () => api.event(detailId!),
    enabled: !!detailId,
  });

  const related = useQuery({
    queryKey: ["events", "related", detailId],
    queryFn: () => api.events({ correlationId: detail.data?.correlationId ?? "", pageSize: 20 }),
    enabled: !!detailId && !!detail.data?.correlationId,
  });

  const apply = (next?: Partial<EventFilters>) => {
    setApplied((prev) => ({ ...prev, ...draft, ...next, page: next?.page ?? 1 }));
  };

  const rows = events.data?.data ?? [];
  const total = events.data?.total ?? 0;
  const page = events.data?.page ?? applied.page;
  const pageSize = applied.pageSize;

  const sevLabel =
    draft.severities.length === 0
      ? T("common.all")
      : draft.severities.map((s) => T(`sev.${s}`)).join(", ");

  return (
    <div className="space-y-4">
      <SectionHeader
        title={T("events.title")}
        desc={T("navDesc.events")}
        actions={
          IS_CONSOLE_EDITION ? (
            <ExportMenu
              buildPath={(format) =>
                exportPath(
                  "/api/events",
                  {
                    q: queryParams.q,
                    severity: queryParams.severity?.join(","),
                    category: queryParams.category,
                    sourceId: queryParams.sourceId,
                    sourceType: queryParams.sourceType,
                    status: queryParams.status,
                    origin: queryParams.origin,
                    from: queryParams.from,
                    to: queryParams.to,
                  },
                  format,
                )
              }
              disabled={events.isLoading}
            />
          ) : undefined
        }
      />

      {/* filter bar */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2 gap-y-2.5">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={draft.q}
              onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder={T("events.searchPlaceholder")}
              className="h-8 ps-8 text-xs"
              aria-label={T("common.search")}
            />
          </div>

          {/* severity multi */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 max-w-44 justify-start gap-1.5 text-xs">
                <SeverityDot severity={draft.severities[0] ?? "info"} />
                <span className="truncate">{sevLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-44 p-2">
              <div className="space-y-1.5">
                {SEVERITIES.map((s) => (
                  <label key={s} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-secondary">
                    <Checkbox
                      checked={draft.severities.includes(s)}
                      onCheckedChange={(c) =>
                        setDraft((d) => ({
                          ...d,
                          severities: c ? [...d.severities, s] : d.severities.filter((x) => x !== s),
                        }))
                      }
                    />
                    <SeverityDot severity={s} />
                    {T(`sev.${s}`)}
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Select value={draft.category} onValueChange={(v) => setDraft((d) => ({ ...d, category: v }))}>
            <SelectTrigger size="sm" className="h-8 w-32 text-xs" aria-label={T("common.category")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c} className="font-mono text-xs">{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={draft.sourceId} onValueChange={(v) => setDraft((d) => ({ ...d, sourceId: v }))}>
            <SelectTrigger size="sm" className="h-8 w-40 text-xs" aria-label={T("common.source")}>
              <SelectValue placeholder={T("events.sourcePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">{T("events.sourcePlaceholder")}</SelectItem>
              {(sources.data ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id} className="font-mono text-xs">{s.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={draft.range} onValueChange={(v) => setDraft((d) => ({ ...d, range: v as RangeKey }))}>
            <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label={T("events.timeRange")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15m" className="text-xs">{T("events.range15m")}</SelectItem>
              <SelectItem value="1h" className="text-xs">{T("events.range1h")}</SelectItem>
              <SelectItem value="6h" className="text-xs">{T("events.range6h")}</SelectItem>
              <SelectItem value="24h" className="text-xs">{T("events.range24h")}</SelectItem>
              <SelectItem value="7d" className="text-xs">{T("events.range7d")}</SelectItem>
              <SelectItem value="custom" className="text-xs">{T("events.rangeCustom")}</SelectItem>
              <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={draft.status} onValueChange={(v) => setDraft((d) => ({ ...d, status: v }))}>
            <SelectTrigger size="sm" className="h-8 w-32 text-xs" aria-label={T("common.status")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
              {["VALIDATED", "PROCESSED", "REJECTED"].map((s) => (
                <SelectItem key={s} value={s} className="text-xs">{T(`eventStatus.${s}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={draft.origin} onValueChange={(v) => setDraft((d) => ({ ...d, origin: v }))}>
            <SelectTrigger size="sm" className="h-8 w-28 text-xs" aria-label={T("common.origin")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
              <SelectItem value="synthetic" className="text-xs">{T("origin.synthetic")}</SelectItem>
              <SelectItem value="external" className="text-xs">{T("origin.external")}</SelectItem>
            </SelectContent>
          </Select>

          <Button size="sm" className="h-8" onClick={() => apply()}>
            {T("common.apply")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
            }}
          >
            <RotateCcw className="size-3.5" /> {T("common.reset")}
          </Button>
        </div>

        {draft.range === "custom" && (
          <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">{T("common.from")}</Label>
              <Input
                type="datetime-local"
                value={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                className="h-8 w-52 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">{T("common.to")}</Label>
              <Input
                type="datetime-local"
                value={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                className="h-8 w-52 text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {/* table */}
      {events.isError ? (
        <ErrorState message={(events.error as Error)?.message} onRetry={() => events.refetch()} />
      ) : events.isLoading ? (
        <SkeletonTable rows={8} cols={7} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={T("events.noEventsTitle")}
          hint={applied.q.trim().length === 1 ? T("events.searchHint") : T("events.noEventsHint")}
        />
      ) : (
        <div className="rounded-md border border-border bg-card">
          {/* table (≥sm) — mobile uses the stacked cards below */}
          <div className="hidden overflow-x-auto sm:block">
            <Table className="sg-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className="w-12" aria-label={T("common.details")} />
                  <TableHead scope="col" className="whitespace-nowrap">{T("common.time")}</TableHead>
                  <TableHead scope="col">{T("common.severity")}</TableHead>
                  <TableHead scope="col" className="hidden md:table-cell">{T("common.category")}</TableHead>
                  <TableHead scope="col" className="hidden lg:table-cell">{T("common.source")}</TableHead>
                  <TableHead scope="col" className="hidden xl:table-cell">{T("common.actor")}</TableHead>
                  <TableHead scope="col">{T("common.message")}</TableHead>
                  <TableHead scope="col" className="hidden sm:table-cell">{T("common.origin")}</TableHead>
                  <TableHead scope="col" className="hidden xl:table-cell">{T("events.correlationId")}</TableHead>
                  <TableHead scope="col" className="hidden md:table-cell">{T("common.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((ev: SgEvent) => (
                  <EventRow
                    key={ev.id}
                    ev={ev}
                    expanded={expanded === ev.id}
                    onToggle={() => setExpanded(expanded === ev.id ? null : ev.id)}
                    onOpen={() => setDetailId(ev.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {/* mobile (<sm): stacked cards — severity + time header, full message, source/actor footer */}
          <div className="divide-y divide-border sm:hidden">
            {rows.map((ev: SgEvent) => (
              <MobileEventCard
                key={ev.id}
                ev={ev}
                expanded={expanded === ev.id}
                onToggle={() => setExpanded(expanded === ev.id ? null : ev.id)}
                onOpen={() => setDetailId(ev.id)}
              />
            ))}
          </div>

          <div className="px-2">
            <PaginationFooter
              page={page}
              pageSize={pageSize}
              total={total}
              onPage={(p) => setApplied((f) => ({ ...f, page: p }))}
              onPageSize={(s) => setApplied((f) => ({ ...f, pageSize: s, page: 1 }))}
            />
          </div>
        </div>
      )}

      {/* detail drawer */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <SheetHeader className="border-b border-border px-4 py-3">
            <SheetTitle className="flex items-center gap-2 text-sm">
              {T("events.eventDetail")}
              {detail.data && <SeverityBadge severity={detail.data.severity} />}
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {detail.isLoading && !detail.data ? (
              <SkeletonTable rows={4} cols={2} />
            ) : detail.data ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">{T("events.eventTime")}</dt>
                  <dd><MonoTime iso={detail.data.eventTime} full /></dd>
                  <dt className="text-muted-foreground">{T("events.ingestTime")}</dt>
                  <dd><MonoTime iso={detail.data.ingestTime} full /></dd>
                  <dt className="text-muted-foreground">{T("common.source")}</dt>
                  <dd dir="ltr" className="sg-num">{detail.data.sourceId} · {detail.data.sourceType}</dd>
                  {detail.data.actor && (
                    <>
                      <dt className="text-muted-foreground">{T("common.actor")}</dt>
                      <dd dir="ltr" className="sg-num">{detail.data.actor}</dd>
                    </>
                  )}
                  {detail.data.correlationId && (
                    <>
                      <dt className="text-muted-foreground">{T("events.correlationId")}</dt>
                      <dd dir="ltr" className="sg-num">{detail.data.correlationId}</dd>
                    </>
                  )}
                  {detail.data.traceId && (
                    <>
                      <dt className="text-muted-foreground">{T("events.traceId")}</dt>
                      <dd dir="ltr" className="sg-num">{detail.data.traceId}</dd>
                    </>
                  )}
                  {detail.data.latencyMs !== null && detail.data.latencyMs !== undefined && (
                    <>
                      <dt className="text-muted-foreground">{T("events.latency")}</dt>
                      <dd dir="ltr" className="sg-num">{detail.data.latencyMs} ms</dd>
                    </>
                  )}
                  {detail.data.rejectionReason && (
                    <>
                      <dt className="text-muted-foreground">{T("events.rejectionReason")}</dt>
                      <dd className="font-mono text-rose-600 dark:text-rose-400">{detail.data.rejectionReason}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">{T("common.status")}</dt>
                  <dd><EventStatusChip status={detail.data.status} /></dd>
                </dl>

                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {T("common.message")}
                  </p>
                  <p className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs">{detail.data.message}</p>
                </div>

                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {T("events.rawJson")}
                  </p>
                  <JsonViewer value={detail.data} maxHeight={280} />
                </div>

                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {T("events.relatedByCorrelation")}
                  </p>
                  {!detail.data.correlationId ? (
                    <p className="text-xs text-muted-foreground">{T("events.noRelated")}</p>
                  ) : (related.data?.data ?? []).filter((r) => r.id !== detail.data!.id).length === 0 ? (
                    <p className="text-xs text-muted-foreground">{T("events.noRelated")}</p>
                  ) : (
                    <ul className="max-h-64 space-y-1 overflow-y-auto pe-1">
                      {(related.data?.data ?? [])
                        .filter((r) => r.id !== detail.data!.id)
                        .map((r) => (
                          <li key={r.id}>
                            <button
                              type="button"
                              onClick={() => setDetailId(r.id)}
                              className="flex min-h-11 w-full items-center gap-2 rounded border border-border bg-secondary/30 px-2 py-1.5 text-start text-xs transition-colors hover:bg-secondary"
                            >
                              <SeverityDot severity={r.severity} />
                              <MonoTime iso={r.eventTime} className="text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{r.message}</span>
                            </button>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <ErrorState onRetry={() => detail.refetch()} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EventRow({
  ev,
  expanded,
  onToggle,
  onOpen,
}: {
  ev: SgEvent;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const T = useT();
  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-no-rowclick]")) return;
          onOpen();
        }}
      >
        <TableCell className="w-12 py-1 ps-2 pe-0">
          <button
            type="button"
            data-no-rowclick
            aria-label={expanded ? T("common.hideDetails") : T("common.showDetails")}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex size-11 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : "rtl:-scale-x-100"}`} />
          </button>
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <MonoTime iso={ev.eventTime} className="text-muted-foreground" />
        </TableCell>
        <TableCell>
          <SeverityBadge severity={ev.severity} />
        </TableCell>
        <TableCell className="hidden font-mono text-[11px] text-muted-foreground md:table-cell">{ev.category}</TableCell>
        <TableCell dir="ltr" title={ev.sourceId} className="hidden max-w-40 truncate font-mono text-[11px] md:table-cell">
          {ev.sourceId}
        </TableCell>
        <TableCell dir="ltr" title={ev.actor ?? "—"} className="hidden max-w-28 truncate font-mono text-[11px] text-muted-foreground xl:table-cell">
          {ev.actor ?? "—"}
        </TableCell>
        <TableCell className="max-w-56">
          <span className="block truncate" title={ev.message}>{ev.message}</span>
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <OriginBadge origin={ev.origin} />
        </TableCell>
        <TableCell dir="ltr" title={ev.correlationId ?? "—"} className="hidden max-w-24 truncate font-mono text-[10px] text-muted-foreground xl:table-cell">
          {ev.correlationId ?? "—"}
        </TableCell>
        <TableCell className="hidden md:table-cell">
          <EventStatusChip status={ev.status} />
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={10} className="bg-secondary/30 p-3">
            <div className="max-w-full overflow-x-auto">
              <JsonViewer value={ev} maxHeight={240} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Stacked-card presentation for <640px: severity+time header, full message, source/actor footer. */
function MobileEventCard({
  ev,
  expanded,
  onToggle,
  onOpen,
}: {
  ev: SgEvent;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const T = useT();
  return (
    <div>
      <button type="button" onClick={onOpen} className="flex w-full flex-col gap-2 p-3 text-start">
        <div className="flex items-center gap-2">
          <SeverityBadge severity={ev.severity} />
          <MonoTime iso={ev.eventTime} className="text-[11px] text-muted-foreground" />
          <span className="flex-1" />
          <EventStatusChip status={ev.status} />
        </div>
        <p className="break-words text-xs leading-snug">{ev.message}</p>
        <p dir="ltr" className="truncate font-mono text-[10px] text-muted-foreground">
          {ev.sourceId}
          {ev.actor ? ` · ${ev.actor}` : ""}
        </p>
      </button>
      <div className="border-t border-border">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? T("common.hideDetails") : T("common.showDetails")}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : "rtl:-scale-x-100"}`} />
          {expanded ? T("common.hideDetails") : T("common.showDetails")}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border p-3">
          <JsonViewer value={ev} maxHeight={240} />
        </div>
      )}
    </div>
  );
}
