"use client";

// StreamGuard Console — Section 8: Correlation Explorer.
// Groups are derived client-side from real detections in the last 24h
// (rule + correlation key), with incident links.
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, Info } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import type { Detection } from "@/lib/types";
import { useUiStore } from "@/lib/store";
import {
  EmptyState,
  ErrorState,
  SectionHeader,
  SeverityDot,
  SkeletonTable,
  StatusChip,
  useT,
} from "../primitives";
import { MonoTime, TimeAgo } from "../time";

interface Group {
  key: string;
  ruleIds: Set<string>;
  detections: Detection[];
  first: string;
  last: string;
  incidents: Set<string>;
  matchedTotal: number;
}

export function CorrelationSection() {
  const T = useT();
  const openIncident = useUiStore((s) => s.openIncident);
  const [expanded, setExpanded] = useState<string | null>(null);

  const from = useMemo(() => new Date(Date.now() - 24 * 3600_000).toISOString(), []);
  const detections = useQuery({
    queryKey: ["detections", "correlation", from],
    queryFn: () => api.detections({ from, page: 1, pageSize: 100 }),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 120_000 });
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.rules, staleTime: 60_000 });

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const d of detections.data?.data ?? []) {
      const key = `${d.ruleId}:${d.detail.actor ?? d.detail.sourceId ?? "global"}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          ruleIds: new Set(),
          detections: [],
          first: d.createdAt,
          last: d.createdAt,
          incidents: new Set(),
          matchedTotal: 0,
        };
        map.set(key, g);
      }
      g.ruleIds.add(d.ruleId);
      g.detections.push(d);
      if (d.incidentId) g.incidents.add(d.incidentId);
      g.matchedTotal += d.detail.matchedCount ?? 0;
      if (d.createdAt < g.first) g.first = d.createdAt;
      if (d.createdAt > g.last) g.last = d.createdAt;
    }
    return [...map.values()].sort((a, b) => b.detections.length - a.detections.length);
  }, [detections.data]);

  return (
    <div className="space-y-4">
      <SectionHeader title={T("correlation.title")} desc={T("navDesc.correlation")} />

      {/* info card */}
      <div className="flex items-start gap-3 rounded-md border border-border bg-card p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          <p>{T("correlation.howItWorksBody")}</p>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <StatusChip tone="ok">
              {T("correlation.windowLabel")}: <span dir="ltr" className="sg-num">{settings.data?.correlationWindowSeconds ?? "—"}s</span>
            </StatusChip>
            {(rules.data ?? []).length > 0 && (
              <StatusChip tone="muted">
                {T("correlation.keyDerivation")}: actor · source_id · global
              </StatusChip>
            )}
            <StatusChip tone="muted">{T("correlation.derivedNote")}</StatusChip>
          </p>
        </div>
      </div>

      {detections.isError ? (
        <ErrorState message={(detections.error as Error)?.message} onRetry={() => detections.refetch()} />
      ) : detections.isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : groups.length === 0 ? (
        <EmptyState title={T("correlation.emptyTitle")} hint={T("correlation.emptyHint")} />
      ) : (
        <div className="rounded-md border border-border bg-card">
          <div className="overflow-x-auto">
            <Table className="sg-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className="w-8" aria-label={T("common.details")} />
                  <TableHead scope="col">{T("correlation.groupKey")}</TableHead>
                  <TableHead scope="col">{T("correlation.rules")}</TableHead>
                  <TableHead scope="col" className="text-center">{T("correlation.eventCount")}</TableHead>
                  <TableHead scope="col" className="hidden md:table-cell">{T("correlation.firstSeen")}</TableHead>
                  <TableHead scope="col">{T("correlation.lastSeen")}</TableHead>
                  <TableHead scope="col">{T("correlation.incidents")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <Fragment key={g.key}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpanded(expanded === g.key ? null : g.key)}
                    >
                      <TableCell>
                        <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${expanded === g.key ? "rotate-90" : ""}`} />
                      </TableCell>
                      <TableCell dir="ltr" className="max-w-48 truncate font-mono text-[11px]">{g.key}</TableCell>
                      <TableCell dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                        {[...g.ruleIds].join(", ")}
                      </TableCell>
                      <TableCell className="text-center">
                        <span dir="ltr" className="sg-num">{g.detections.length}</span>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        <MonoTime iso={g.first} className="text-muted-foreground" />
                      </TableCell>
                      <TableCell>
                        <TimeAgo iso={g.last} className="text-[11px]" />
                      </TableCell>
                      <TableCell>
                        {g.incidents.size === 0 ? (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        ) : (
                          <span dir="ltr" className="flex flex-wrap gap-1">
                            {[...g.incidents].map((id) => (
                              <button
                                key={id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openIncident(id);
                                }}
                                className="inline-flex items-center gap-1 font-mono text-[11px] text-emerald-600 hover:underline dark:text-emerald-400"
                              >
                                {id} <ExternalLink className="size-3" />
                              </button>
                            ))}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                    {expanded === g.key && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={7} className="bg-secondary/30 p-3">
                          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {T("correlation.timeline")}
                          </p>
                          <ol className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
                            {g.detections
                              .slice()
                              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                              .map((d) => (
                                <li key={d.id} className="flex items-center gap-1.5 text-[11px]">
                                  <SeverityDot severity={d.severity} />
                                  <MonoTime iso={d.createdAt} className="text-muted-foreground" />
                                  <span dir="ltr" className="sg-num text-muted-foreground/70">×{d.detail.matchedCount}</span>
                                </li>
                              ))}
                          </ol>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
