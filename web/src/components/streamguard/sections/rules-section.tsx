"use client";

// StreamGuard Console — Section 4: Detection Rules.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FlaskConical, Pencil, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api-client";
import { SEVERITIES, type SessionUser, type Severity, type SgEvent, type SgRule } from "@/lib/types";
import { isAnalystPlus } from "@/lib/store";
import {
  EmptyState,
  ErrorState,
  SectionHeader,
  SeverityBadge,
  SeverityDot,
  SkeletonTable,
  useT,
} from "../primitives";
import { MonoTime, TimeAgo } from "../time";

export function RulesSection({ user }: { user?: SessionUser | null }) {
  const T = useT();
  const qc = useQueryClient();
  const [editRule, setEditRule] = useState<SgRule | null>(null);
  const [previewRule, setPreviewRule] = useState<SgRule | null>(null);
  // Elements that opened the dialogs — focus is restored there on close (a11y).
  const editReturnRef = useRef<HTMLElement | null>(null);
  const previewReturnRef = useRef<HTMLElement | null>(null);

  const rules = useQuery({ queryKey: ["rules"], queryFn: api.rules });

  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.patchRule>[1] }) => api.patchRule(id, patch),
    onSuccess: (rule) => {
      toast.success(T("toasts.ruleUpdated", { id: rule.id, v: rule.version }));
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (err: Error) => {
      const status = (err as ApiError).status;
      toast.error(status === 403 ? T("toasts.forbidden") : `${T("toasts.ruleUpdateFailed")}: ${err.message}`);
    },
  });

  const canEdit = isAnalystPlus(user?.role);

  return (
    <div className="space-y-4">
      <SectionHeader title={T("rules.title")} desc={T("navDesc.rules")} />

      {rules.isError ? (
        <ErrorState message={(rules.error as Error)?.message} onRetry={() => rules.refetch()} />
      ) : rules.isLoading ? (
        <SkeletonTable rows={7} cols={7} />
      ) : (rules.data ?? []).length === 0 ? (
        <EmptyState title={T("states.empty")} hint={T("states.empty")} />
      ) : (
        <div className="rounded-md border border-border bg-card">
          <div className="overflow-x-auto">
            <Table className="sg-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className="w-24">ID</TableHead>
                  <TableHead scope="col">{T("rules.rule")}</TableHead>
                  <TableHead scope="col">{T("common.severity")}</TableHead>
                  <TableHead scope="col" className="whitespace-nowrap">
                    {T("rules.threshold")} / {T("rules.window")}
                  </TableHead>
                  <TableHead scope="col">{T("rules.cooldown")}</TableHead>
                  <TableHead scope="col" className="text-center">{T("rules.fires24h")}</TableHead>
                  <TableHead scope="col">{T("rules.lastFired")}</TableHead>
                  <TableHead scope="col">{T("rules.version")}</TableHead>
                  <TableHead scope="col">{T("common.enabled")}</TableHead>
                  <TableHead scope="col" className="text-end">{T("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(rules.data ?? []).map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell dir="ltr">
                      <span className="sg-num text-[11px] text-muted-foreground">{rule.id}</span>
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-56 truncate font-medium" title={rule.description}>
                        {rule.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <SeverityBadge severity={rule.severity} />
                    </TableCell>
                    <TableCell dir="ltr" className="whitespace-nowrap font-mono text-[11px]">
                      {rule.conditionType === "sequence" ? "seq" : rule.conditionType === "ratio" ? "ratio" : "≥"}
                      {rule.threshold} / {rule.windowSeconds}s
                    </TableCell>
                    <TableCell dir="ltr" className="font-mono text-[11px] text-muted-foreground">{rule.cooldownSeconds}s</TableCell>
                    <TableCell className="text-center">
                      <span dir="ltr" className="sg-num">{rule.fireCount24h ?? 0}</span>
                    </TableCell>
                    <TableCell>
                      <TimeAgo iso={rule.lastFiredAt ?? undefined} className="text-[11px] text-muted-foreground" />
                    </TableCell>
                    <TableCell dir="ltr">
                      <span className="sg-num text-[11px]">v{rule.version}</span>
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Switch
                              checked={rule.enabled}
                              disabled={!canEdit || patchMutation.isPending}
                              onCheckedChange={(c) => patchMutation.mutate({ id: rule.id, patch: { enabled: c } })}
                              aria-label={`${T("common.enabled")} ${rule.id}`}
                            />
                          </span>
                        </TooltipTrigger>
                        {!canEdit && <TooltipContent side="top">{T("rules.viewerHint")}</TooltipContent>}
                      </Tooltip>
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              aria-label={T("rules.testRule")}
                              onClick={() => {
                                previewReturnRef.current = document.activeElement as HTMLElement | null;
                                setPreviewRule(rule);
                              }}
                            >
                              <FlaskConical className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{T("rules.testRule")}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7"
                              aria-label={T("common.edit")}
                              disabled={!canEdit}
                              onClick={() => {
                                editReturnRef.current = document.activeElement as HTMLElement | null;
                                setEditRule(rule);
                              }}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{canEdit ? T("common.edit") : T("rules.viewerHint")}</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <EditRuleDialog
        rule={editRule}
        returnRef={editReturnRef}
        onClose={() => setEditRule(null)}
        onSave={(patch) => {
          if (editRule) patchMutation.mutate({ id: editRule.id, patch });
          setEditRule(null);
        }}
        saving={patchMutation.isPending}
      />

      <SelectorPreviewDialog rule={previewRule} returnRef={previewReturnRef} onClose={() => setPreviewRule(null)} />
    </div>
  );
}

/* ------------------------------ Edit dialog ------------------------------ */

function EditRuleDialog({
  rule,
  returnRef,
  onClose,
  onSave,
  saving,
}: {
  rule: SgRule | null;
  returnRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSave: (patch: { threshold?: number; windowSeconds?: number; cooldownSeconds?: number; severity?: Severity; enabled?: boolean }) => void;
  saving: boolean;
}) {
  const T = useT();
  const [threshold, setThreshold] = useState(1);
  const [windowSeconds, setWindowSeconds] = useState(60);
  const [cooldown, setCooldown] = useState(0);
  const [severity, setSeverity] = useState<Severity>("medium");
  const [enabled, setEnabled] = useState(true);
  const [open, setOpen] = useState(false);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  if (rule && initializedFor !== rule.id) {
    setInitializedFor(rule.id);
    setThreshold(rule.threshold);
    setWindowSeconds(rule.windowSeconds);
    setCooldown(rule.cooldownSeconds);
    setSeverity(rule.severity);
    setEnabled(rule.enabled);
    setOpen(true);
  }
  if (!rule && open) setOpen(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
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
          <DialogTitle className="flex items-center gap-2 text-sm">
            {T("rules.editRule")}
            {rule && <span dir="ltr" className="sg-num text-xs text-muted-foreground">{rule.id}</span>}
          </DialogTitle>
          <DialogDescription className="text-xs">{T("rules.editRuleDesc")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">
              {T("rules.threshold")} <span className="text-muted-foreground">({T("rules.thresholdHint")})</span>
            </Label>
            <Input
              type="number"
              min={1}
              max={10000}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="h-8 font-mono text-xs"
              dir="ltr"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {T("rules.window")} <span className="text-muted-foreground">(s)</span>
            </Label>
            <Input
              type="number"
              min={10}
              max={3600}
              value={windowSeconds}
              onChange={(e) => setWindowSeconds(Number(e.target.value))}
              className="h-8 font-mono text-xs"
              dir="ltr"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {T("rules.cooldown")} <span className="text-muted-foreground">(s)</span>
            </Label>
            <Input
              type="number"
              min={0}
              max={3600}
              value={cooldown}
              onChange={(e) => setCooldown(Number(e.target.value))}
              className="h-8 font-mono text-xs"
              dir="ltr"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{T("common.severity")}</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
              <SelectTrigger size="sm" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">{T(`sev.${s}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="rule-enabled" />
            <Label htmlFor="rule-enabled" className="text-xs">
              {enabled ? T("common.enabled") : T("common.disabled")}
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {T("common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={saving}
            onClick={() =>
              onSave({
                threshold,
                windowSeconds,
                cooldownSeconds: cooldown,
                severity,
                enabled,
              })
            }
          >
            {saving ? T("common.saving") : T("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- Selector preview ---------------------------- */

function SelectorPreviewDialog({
  rule,
  returnRef,
  onClose,
}: {
  rule: SgRule | null;
  returnRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const T = useT();

  const preview = useQuery({
    queryKey: ["rules", "preview", rule?.id],
    queryFn: async () => {
      const r = rule!;
      const from = new Date(Date.now() - 24 * 3600_000).toISOString();
      const res = await api.events({
        from,
        pageSize: 100,
        category: r.selector.category,
        severity: r.selector.severity,
        status: "PROCESSED",
      });
      const matches = (res.data as SgEvent[]).filter((ev) => {
        if (r.selector.severity && !r.selector.severity.includes(ev.severity)) return false;
        if (r.selector.sourceIdPrefix && !ev.sourceId.startsWith(r.selector.sourceIdPrefix)) return false;
        if (r.selector.attribute) {
          const val = ev.attributes?.[r.selector.attribute.key];
          if (String(val ?? null) !== r.selector.attribute.value) return false;
        }
        return true;
      });
      return { fetched: res.data.length, matches };
    },
    enabled: !!rule,
    staleTime: 0,
  });

  const selectorSummary = useMemo(() => {
    if (!rule) return "";
    const parts: string[] = [];
    if (rule.selector.category) parts.push(`category=${rule.selector.category}`);
    if (rule.selector.severity?.length) parts.push(`severity=${rule.selector.severity.join("|")}`);
    if (rule.selector.sourceIdPrefix) parts.push(`source^=${rule.selector.sourceIdPrefix}`);
    if (rule.selector.attribute) parts.push(`${rule.selector.attribute.key}=${rule.selector.attribute.value}`);
    return parts.join(" · ") || "*";
  }, [rule]);

  if (!rule) return null;

  return (
    <Dialog open={!!rule} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="sm:max-w-lg"
        onCloseAutoFocus={(e) => {
          // no DialogTrigger here — restore focus to the button that opened the dialog
          if (returnRef.current) {
            e.preventDefault();
            returnRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FlaskConical className="size-4 text-emerald-600 dark:text-emerald-400" />
            {T("rules.testRule")}
            <span dir="ltr" className="sg-num text-xs text-muted-foreground">{rule.id}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">{T("rules.testRuleDesc")}</DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-[11px]" dir="ltr">
          {selectorSummary}
        </div>

        {preview.isLoading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{T("common.loading")}</p>
        ) : preview.isError ? (
          <ErrorState message={(preview.error as Error)?.message} onRetry={() => preview.refetch()} />
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs">
              <ShieldQuestion className="size-4 text-muted-foreground" />
              <span>
                <span dir="ltr" className="sg-num text-base font-semibold text-emerald-600 dark:text-emerald-400">
                  {preview.data?.matches.length ?? 0}
                </span>{" "}
                / <span dir="ltr" className="sg-num">{preview.data?.fetched ?? 0}</span> {T("rules.matchingEvents")}
              </span>
            </div>

            {(preview.data?.matches.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">{T("rules.noMatches")}</p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto pe-1">
                {(preview.data?.matches ?? []).slice(0, 25).map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-[11px]">
                    <SeverityDot severity={ev.severity} />
                    <MonoTime iso={ev.eventTime} className="w-16 shrink-0 text-muted-foreground" />
                    <span dir="ltr" className="w-24 shrink-0 truncate font-mono">{ev.sourceId}</span>
                    <span dir="ltr" className="w-20 shrink-0 truncate font-mono text-muted-foreground">{ev.actor ?? "—"}</span>
                    <span className="min-w-0 flex-1 truncate">{ev.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-muted-foreground">{T("rules.previewNote")}</p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
