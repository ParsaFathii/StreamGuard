"use client";

// StreamGuard Console — Section 13: Audit History (ADMIN only; locked for others).
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import type { SessionUser } from "@/lib/types";
import { isAdmin } from "@/lib/store";
import {
  Badge,
  EmptyState,
  ErrorState,
  SectionHeader,
  SkeletonTable,
  useT,
} from "../primitives";
import { JsonViewer } from "../json-viewer";
import { MonoTime } from "../time";
import { PaginationFooter } from "../pagination";

export function AuditSection({ user }: { user: SessionUser }) {
  const T = useT();

  if (!isAdmin(user.role)) {
    return (
      <div className="space-y-4">
        <SectionHeader title={T("audit.title")} desc={T("navDesc.audit")} />
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card px-6 py-16 text-center">
          <Lock className="size-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">{T("audit.lockedTitle")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{T("audit.lockedBody")}</p>
          <Badge variant="outline" className="mt-1 border-amber-500/50 bg-amber-400/10 font-mono text-[10px] text-amber-700 dark:border-amber-400/40 dark:bg-transparent dark:text-amber-300">
            ADMIN
          </Badge>
        </div>
      </div>
    );
  }

  return <AuditTable T={T} />;
}

function AuditTable({ T }: { T: ReturnType<typeof useT> }) {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [applied, setApplied] = useState({ actor: "", action: "", targetType: "" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expanded, setExpanded] = useState<string | null>(null);

  const params = useMemo(
    () => ({
      actor: applied.actor.trim() || undefined,
      action: applied.action.trim() || undefined,
      targetType: applied.targetType.trim() || undefined,
      page,
      pageSize,
    }),
    [applied, page, pageSize],
  );

  const audit = useQuery({
    queryKey: ["audit", params],
    queryFn: () => api.audit(params),
    placeholderData: (prev) => prev,
  });

  const rows = audit.data?.data ?? [];

  return (
    <div className="space-y-4">
      <SectionHeader title={T("audit.title")} desc={T("navDesc.audit")} />

      {/* filters */}
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3">
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">{T("audit.actor")}</Label>
          <Input
            dir="ltr"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (setApplied({ actor, action, targetType }), setPage(1))}
            placeholder="admin"
            className="h-8 w-32 font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">{T("audit.action")}</Label>
          <Input
            dir="ltr"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (setApplied({ actor, action, targetType }), setPage(1))}
            placeholder="rule.update"
            className="h-8 w-36 font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">{T("audit.targetType")}</Label>
          <Input
            dir="ltr"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (setApplied({ actor, action, targetType }), setPage(1))}
            placeholder="rule"
            className="h-8 w-28 font-mono text-xs"
          />
        </div>
        <Button
          size="sm"
          className="h-8"
          onClick={() => {
            setApplied({ actor, action, targetType });
            setPage(1);
          }}
        >
          {T("common.apply")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={() => {
            setActor("");
            setAction("");
            setTargetType("");
            setApplied({ actor: "", action: "", targetType: "" });
            setPage(1);
          }}
        >
          {T("common.reset")}
        </Button>
      </div>

      {audit.isError ? (
        <ErrorState message={(audit.error as Error)?.message} onRetry={() => audit.refetch()} />
      ) : audit.isLoading ? (
        <SkeletonTable rows={10} cols={5} />
      ) : rows.length === 0 ? (
        <EmptyState title={T("audit.emptyTitle")} hint={T("audit.emptyHint")} />
      ) : (
        <div className="rounded-md border border-border bg-card">
          <div className="overflow-x-auto">
            <Table className="sg-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className="w-8" aria-label={T("common.details")} />
                  <TableHead scope="col">{T("common.time")}</TableHead>
                  <TableHead scope="col">{T("audit.actor")}</TableHead>
                  <TableHead scope="col" className="hidden sm:table-cell">{T("audit.role")}</TableHead>
                  <TableHead scope="col">{T("audit.action")}</TableHead>
                  <TableHead scope="col" className="hidden md:table-cell">{T("audit.target")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <Fragment key={a.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                    >
                      <TableCell>
                        <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${expanded === a.id ? "rotate-90" : ""}`} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <MonoTime iso={a.ts} full className="text-muted-foreground" />
                      </TableCell>
                      <TableCell dir="ltr" className="font-mono text-[11px]">{a.actor}</TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="outline" className="border-border font-mono text-[9px] text-muted-foreground">
                          {a.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <code dir="ltr" className="sg-num rounded border border-border bg-secondary/60 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                          {a.action}
                        </code>
                      </TableCell>
                      <TableCell dir="ltr" className="hidden max-w-44 truncate font-mono text-[10px] text-muted-foreground md:table-cell">
                        {a.targetType ? `${a.targetType}${a.targetId ? `:${a.targetId}` : ""}` : "—"}
                      </TableCell>
                    </TableRow>
                    {expanded === a.id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="bg-secondary/30 p-3">
                          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {T("audit.detailsJson")}
                          </p>
                          <JsonViewer value={a.details} maxHeight={220} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="px-2">
            <PaginationFooter
              page={audit.data?.page ?? page}
              pageSize={pageSize}
              total={audit.data?.total ?? 0}
              onPage={setPage}
              onPageSize={(s) => {
                setPageSize(s);
                setPage(1);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
