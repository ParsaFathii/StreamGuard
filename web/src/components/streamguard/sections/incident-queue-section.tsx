"use client";

// StreamGuard Console — Section 6: Incident Queue (kanban on xl, list on small screens).
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  ClipboardList,
  Inbox,
  MoreHorizontal,
  SearchCheck,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";
import type { Incident, IncidentStatus, SessionUser, Severity } from "@/lib/types";
import { isAnalystPlus, useUiStore } from "@/lib/store";
import {
  EmptyState,
  ErrorState,
  IncidentStatusChip,
  SEVERITY_UI,
  SectionHeader,
  SeverityBadge,
  SkeletonCards,
  useT,
} from "../primitives";
import { TimeAgo } from "../time";

const STATUSES: IncidentStatus[] = ["NEW", "TRIAGED", "INVESTIGATING", "RESOLVED", "CLOSED"];

const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  NEW: ["TRIAGED", "INVESTIGATING", "RESOLVED", "CLOSED"],
  TRIAGED: ["INVESTIGATING", "RESOLVED", "CLOSED"],
  INVESTIGATING: ["TRIAGED", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "INVESTIGATING"],
  CLOSED: ["INVESTIGATING"], // admin reopen only (server enforces)
};

export function IncidentQueueSection({ user }: { user: SessionUser }) {
  const T = useT();
  const qc = useQueryClient();
  const openIncident = useUiStore((s) => s.openIncident);
  const canEdit = isAnalystPlus(user.role);

  const [severityFilter, setSeverityFilter] = useState("all");
  const [sort, setSort] = useState("createdAt");
  const [statusFilter, setStatusFilter] = useState<string>("all"); // list mode only
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resolveTarget, setResolveTarget] = useState<Incident | null>(null);
  const [bulkStatus, setBulkStatus] = useState<string>("");
  // Element that opened the resolve dialog — focus is restored there on close (a11y).
  const resolveReturnRef = useRef<HTMLElement | null>(null);

  const incidents = useQuery({
    queryKey: ["incidents", "queue", { sort }],
    queryFn: () => api.incidents({ sort, page: 1, pageSize: 100 }),
    placeholderData: (prev) => prev,
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.patchIncident>[1] }) =>
      api.patchIncident(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["incidents"] });
      const prev = qc.getQueriesData({ queryKey: ["incidents"] });
      qc.setQueriesData({ queryKey: ["incidents"] }, (old: unknown) => {
        const o = old as { data?: Incident[] } | undefined;
        if (!o?.data) return old;
        return { ...o, data: o.data.map((inc) => (inc.id === id ? { ...inc, ...patch } : inc)) };
      });
      return { prev };
    },
    onError: (err: Error, { id }, ctx) => {
      // optimistic rollback
      if (ctx?.prev) {
        for (const [key, data] of ctx.prev) qc.setQueryData(key, data);
      }
      const ae = err as ApiError;
      toast.error(
        ae.status === 403
          ? T("toasts.forbidden")
          : ae.code === "INVALID_TRANSITION"
            ? T("toasts.invalidTransition")
            : T("toasts.incidentUpdateFailed", { id }),
      );
    },
    onSuccess: (_d, { id }) => toast.success(T("toasts.incidentUpdated", { id })),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["incidents"] });
      qc.invalidateQueries({ queryKey: ["incident"] });
    },
  });

  const act = (inc: Incident, patch: Parameters<typeof api.patchIncident>[1]) =>
    patchMutation.mutate({ id: inc.id, patch });

  const items = useMemo(() => {
    let list = incidents.data?.data ?? [];
    if (severityFilter !== "all") list = list.filter((i) => i.severity === severityFilter);
    if (statusFilter !== "all") list = list.filter((i) => i.status === statusFilter);
    return list;
  }, [incidents.data, severityFilter, statusFilter]);

  const byStatus = useMemo(() => {
    const map = new Map<IncidentStatus, Incident[]>([
      ["NEW", []],
      ["TRIAGED", []],
      ["INVESTIGATING", []],
      ["RESOLVED", []],
      ["CLOSED", []],
    ]);
    (incidents.data?.data ?? [])
      .filter((i) => severityFilter === "all" || i.severity === severityFilter)
      .forEach((i) => map.get(i.status)?.push(i));
    return map;
  }, [incidents.data, severityFilter]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkApply = async () => {
    if (!bulkStatus) return;
    const ids = [...selected];
    const results = await Promise.allSettled(
      ids.map((id) => api.patchIncident(id, { status: bulkStatus })),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) toast.error(T("toasts.incidentUpdateFailed", { id: `${ids.length - failed}/${ids.length}` }));
    else toast.success(T("toasts.incidentUpdated", { id: `${ids.length}` }));
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["incidents"] });
  };

  const renderCard = (inc: Incident) => (
    <IncidentCard
      key={inc.id}
      inc={inc}
      canEdit={canEdit}
      isAdmin={user.role === "ADMIN"}
      selected={selected.has(inc.id)}
      onToggleSelect={() => toggleSelect(inc.id)}
      onOpen={() => openIncident(inc.id)}
      username={user.username}
      onAct={(patch) => {
        if (patch.status === "RESOLVED") {
          resolveReturnRef.current = document.activeElement as HTMLElement | null;
          setResolveTarget(inc);
        } else act(inc, patch);
      }}
    />
  );

  return (
    <div className="space-y-4">
      <SectionHeader title={T("incidents.title")} desc={T("navDesc.incidents")} />

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3">
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger size="sm" className="h-8 w-32 text-xs" aria-label={T("incidents.filterSeverity")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
            {(["critical", "high", "medium", "low", "info"] as Severity[]).map((s) => (
              <SelectItem key={s} value={s} className="text-xs">{T(`sev.${s}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label={T("incidents.filterStatus")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">{T("incidents.allStatuses")}</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">{T(`incStatus.${s}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger size="sm" className="h-8 w-40 text-xs" aria-label={T("incidents.sortBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="createdAt" className="text-xs">{T("incidents.sortCreated")}</SelectItem>
            <SelectItem value="severity" className="text-xs">{T("incidents.sortSeverity")}</SelectItem>
            <SelectItem value="updatedAt" className="text-xs">{T("incidents.sortUpdated")}</SelectItem>
          </SelectContent>
        </Select>

        <span className="flex-1" />

        {selected.size > 0 && canEdit && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1">
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{T("incidents.bulkSelected", { n: selected.size })}</span>
            <Select value={bulkStatus} onValueChange={setBulkStatus}>
              <SelectTrigger size="sm" className="h-7 w-32 text-xs" aria-label={T("incidents.bulkMove")}>
                <SelectValue placeholder={T("incidents.bulkMove")} />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">{T(`incStatus.${s}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="h-7" disabled={!bulkStatus} onClick={bulkApply}>
              {T("incidents.bulkApply")}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())} aria-label={T("incidents.clearSelection")}>
              <X className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {incidents.isError ? (
        <ErrorState message={(incidents.error as Error)?.message} onRetry={() => incidents.refetch()} />
      ) : incidents.isLoading ? (
        <SkeletonCards count={6} />
      ) : items.length === 0 ? (
        <EmptyState title={T("incidents.emptyTitle")} hint={T("incidents.emptyHint")} />
      ) : (
        <>
          {/* list mode (< xl) */}
          <div className="grid gap-2 md:grid-cols-2 xl:hidden">
            {items.map(renderCard)}
          </div>

          {/* kanban (xl+) */}
          <div className="hidden gap-3 xl:grid xl:grid-cols-5">
            {STATUSES.map((status) => (
              <div key={status} className="min-w-0 rounded-md border border-border bg-sidebar/60">
                <div className="flex items-center justify-between border-b border-border px-2.5 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide">{T(`incStatus.${status}`)}</span>
                  <span dir="ltr" className="sg-num rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">
                    {byStatus.get(status)?.length ?? 0}
                  </span>
                </div>
                <div className="flex max-h-[calc(100dvh-340px)] flex-col gap-2 overflow-y-auto p-2">
                  {(byStatus.get(status) ?? []).map(renderCard)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <ResolveDialog
        inc={resolveTarget}
        returnRef={resolveReturnRef}
        onClose={() => setResolveTarget(null)}
        onConfirm={(summary) => {
          if (resolveTarget) act(resolveTarget, { status: "RESOLVED", resolutionSummary: summary });
          setResolveTarget(null);
        }}
      />
    </div>
  );
}

/* ------------------------------ Incident card ---------------------------- */

function IncidentCard({
  inc,
  canEdit,
  isAdmin,
  username,
  selected,
  onToggleSelect,
  onOpen,
  onAct,
}: {
  inc: Incident;
  canEdit: boolean;
  isAdmin: boolean;
  username: string;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onAct: (patch: Parameters<typeof api.patchIncident>[1]) => void;
}) {
  const T = useT();
  const sev = SEVERITY_UI[inc.severity];
  const actions = TRANSITIONS[inc.status] ?? [];

  // Build the full action list, then show at most 3 primary buttons and fold
  // the rest into an overflow "…" menu — one consistent layout on every card.
  const all: Array<{ key: string; label: string; icon: LucideIcon; run: () => void }> = [];
  if (inc.assignedTo === null)
    all.push({ key: "assign", label: T("incidents.assignToMe"), icon: UserPlus, run: () => onAct({ assignedTo: username }) });
  if (inc.status === "NEW")
    all.push({ key: "triage", label: T("incidents.triage"), icon: ClipboardList, run: () => onAct({ status: "TRIAGED" }) });
  if (canEdit && (inc.status === "NEW" || inc.status === "TRIAGED"))
    all.push({ key: "investigate", label: T("incidents.investigate"), icon: SearchCheck, run: () => onAct({ status: "INVESTIGATING" }) });
  if (canEdit && actions.includes("RESOLVED"))
    all.push({ key: "resolve", label: T("incidents.resolve"), icon: CheckCircle2, run: () => onAct({ status: "RESOLVED", resolutionSummary: "" }) });
  if (canEdit && inc.status === "RESOLVED")
    all.push({ key: "close", label: T("incidents.close"), icon: CircleSlash, run: () => onAct({ status: "CLOSED" }) });
  if (canEdit && inc.status === "CLOSED" && isAdmin)
    all.push({ key: "reopen", label: `${T("investigate.moveTo")} INVESTIGATING`, icon: SearchCheck, run: () => onAct({ status: "INVESTIGATING" }) });
  const primary = all.slice(0, 3);
  const overflow = all.slice(3);

  return (
    <article
      className={`rounded-md border bg-card transition-colors ${
        selected ? "border-emerald-500/50" : "border-border hover:border-[var(--sg-border-strong)]"
      }`}
    >
      <div className={`h-0.5 rounded-t-md ${sev.bar}`} />
      <div className="p-3">
        <div className="flex items-start gap-2">
          {canEdit && (
            <Checkbox
              checked={selected}
              onCheckedChange={onToggleSelect}
              className="mt-0.5"
              aria-label={T("incidents.selectIncident", { id: inc.id })}
            />
          )}
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-start">
            <div className="flex items-center gap-2">
              <span dir="ltr" title={inc.id} className="sg-num shrink-0 text-[11px] text-muted-foreground">{inc.id}</span>
              <SeverityBadge severity={inc.severity} />
            </div>
            <p className="mt-1 line-clamp-2 break-words text-[13px] font-medium leading-snug" title={inc.title}>
              {inc.title}
            </p>
            <p
              dir="ltr"
              title={`${inc.ruleId} · ${inc.correlationLabel}: ${inc.correlationKey}`}
              className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
            >
              {inc.ruleId} · {inc.correlationLabel}: {inc.correlationKey}
            </p>
          </button>
          <IncidentStatusChip status={inc.status} className="hidden sm:inline-flex" />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
          <span dir="ltr">{inc.eventCount} {T("incidents.events")}</span>
          <span dir="ltr">{inc.detectionCount} {T("incidents.detections")}</span>
          <span>
            {T("incidents.age")}: <TimeAgo iso={inc.createdAt} />
          </span>
          <span className="max-w-32 truncate" title={`${T("incidents.assignee")}: ${inc.assignedTo ?? T("incidents.unassigned")}`}>
            {T("incidents.assignee")}: {inc.assignedTo ?? T("incidents.unassigned")}
          </span>
        </div>

        {canEdit && (
          <>
            <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
              {primary.map((a) => (
                <Button key={a.key} size="sm" variant="outline" className="h-11 px-2.5 text-[11px] sm:h-7 sm:px-2" onClick={a.run}>
                  <a.icon className="size-3" /> {a.label}
                </Button>
              ))}
              {overflow.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-11 w-11 gap-0 p-0 sm:h-7 sm:w-7"
                      aria-label={T("common.moreActions")}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {overflow.map((a) => (
                      <DropdownMenuItem key={a.key} onClick={a.run} className="gap-2 text-xs">
                        <a.icon className="size-3.5" /> {a.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 flex min-h-11 w-full items-center justify-between px-2 text-[11px] sm:min-h-8"
              onClick={onOpen}
            >
              {T("incidents.openIncident")}
              <ChevronRight className="size-3.5 rtl:-scale-x-100" />
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

/* ------------------------------ Resolve dialog --------------------------- */

function ResolveDialog({
  inc,
  returnRef,
  onClose,
  onConfirm,
}: {
  inc: Incident | null;
  returnRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: (summary: string) => void;
}) {
  const T = useT();
  const [summary, setSummary] = useState("");
  const [touched, setTouched] = useState(false);
  const [initialized, setInitialized] = useState<string | null>(null);

  if (inc && initialized !== inc.id) {
    setInitialized(inc.id);
    setSummary("");
    setTouched(false);
  }

  const tooShort = touched && summary.trim().length < 10;

  return (
    <Dialog open={!!inc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(e) => {
          // no DialogTrigger here — restore focus to the button that opened the dialog
          if (returnRef.current) {
            e.preventDefault();
            returnRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {T("incidents.resolveTitle")} <span dir="ltr" className="sg-num text-xs text-muted-foreground">{inc?.id}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">{T("incidents.resolveDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="resolution-summary" className="text-xs">
            {T("incidents.summaryLabel")}
          </Label>
          <Textarea
            id="resolution-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder={T("incidents.summaryPlaceholder")}
            className="min-h-24 text-xs"
            maxLength={4000}
          />
          {tooShort && <p className="text-[11px] text-rose-600 dark:text-rose-400">{T("incidents.summaryTooShort")}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {T("common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={summary.trim().length < 10}
            onClick={() => onConfirm(summary.trim())}
          >
            <CheckCircle2 className="size-4" /> {T("incidents.resolve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
