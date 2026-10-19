"use client";

// StreamGuard Console — Section 11: Ingestion Sources (+ ingest docs + test event + scenarios).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Send, Terminal } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, ApiError } from "@/lib/api-client";
import { CATEGORIES, SEVERITIES, type SessionUser, type Severity } from "@/lib/types";
import { isAnalystPlus } from "@/lib/store";
import {
  EmptyState,
  ErrorState,
  MeterBar,
  OriginBadge,
  SectionHeader,
  SkeletonTable,
  StatusChip,
  useT,
} from "../primitives";
import { TimeAgo } from "../time";
import { ScenarioRunButtons } from "../simulator";

const CURL_EXAMPLE = `curl -X POST '/api/ingest' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Ingest-Key: demo-key-01' \\
  -d '{
    "event_id": "<uuid v4>",
    "schema_version": 1,
    "event_time": "2026-01-01T12:00:00.000Z",
    "source_id": "my-app-01",
    "source_type": "app",
    "severity": "info",
    "category": "auth",
    "message": "User login succeeded",
    "attributes": { "action": "login_success" },
    "actor": "user-42"
  }'`;

export function SourcesSection({ user }: { user: SessionUser }) {
  const T = useT();
  const canIngest = isAnalystPlus(user.role);

  const sources = useQuery({ queryKey: ["sources"], queryFn: api.sources, refetchInterval: 30_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 120_000 });
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: api.scenarios, staleTime: 300_000, enabled: canIngest });

  const [form, setForm] = useState({
    sourceId: "sim-app-01",
    severity: "info" as Severity,
    category: "auth",
    message: "",
  });
  const [sending, setSending] = useState(false);

  const maxEvents = Math.max(1, ...(sources.data ?? []).map((s) => s.events24h));

  const sendTest = async () => {
    setSending(true);
    try {
      const res = await api.ingest({
        event_id: crypto.randomUUID(),
        schema_version: 1,
        event_time: new Date().toISOString(),
        source_id: form.sourceId,
        source_type: "synthetic",
        severity: form.severity,
        category: form.category as (typeof CATEGORIES)[number],
        message: form.message || "Test event from StreamGuard console",
        attributes: { action: "test_event" },
        actor: "console-test",
      });
      toast.success(
        `${T("sources.sent")} — ${T("sources.result", { a: res.accepted ?? 0, d: res.duplicates ?? 0, r: res.rejected ?? 0 })}`,
      );
      setForm((f) => ({ ...f, message: "" }));
    } catch (err) {
      const ae = err as ApiError;
      toast.error(ae.status === 403 ? T("toasts.forbidden") : `${T("toasts.testEventFailed")}: ${ae.message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeader title={T("sources.title")} desc={T("navDesc.sources")} />

      {/* sources table */}
      {sources.isError ? (
        <ErrorState message={(sources.error as Error)?.message} onRetry={() => sources.refetch()} />
      ) : sources.isLoading ? (
        <SkeletonTable rows={5} cols={5} />
      ) : (sources.data ?? []).length === 0 ? (
        <EmptyState title={T("sources.emptyTitle")} hint={T("sources.emptyHint")} />
      ) : (
        <div className="rounded-md border border-border bg-card">
          <div className="overflow-x-auto">
            <Table className="sg-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">{T("common.source")}</TableHead>
                  <TableHead scope="col" className="hidden sm:table-cell">{T("common.category")}</TableHead>
                  <TableHead scope="col" className="hidden md:table-cell">{T("common.origin")}</TableHead>
                  <TableHead scope="col" className="w-44">{T("sources.events24h")}</TableHead>
                  <TableHead scope="col" className="hidden lg:table-cell">{T("sources.lastEvent")}</TableHead>
                  <TableHead scope="col">{T("sources.statusCol")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(sources.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell dir="ltr" className="font-mono text-[11px]">{s.id}</TableCell>
                    <TableCell dir="ltr" className="hidden font-mono text-[11px] text-muted-foreground sm:table-cell">{s.type}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      <OriginBadge origin={s.origin} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span dir="ltr" className="sg-num w-14 text-end">{s.events24h.toLocaleString("en-US")}</span>
                        <MeterBar value={s.events24h} max={maxEvents} color="#10B981" className="w-16" />
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <TimeAgo iso={s.lastEventAt} className="text-[11px] text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <StatusChip tone={s.status === "active" ? "ok" : s.status === "error" ? "error" : "muted"}>
                        {T(`sources.${s.status === "error" ? "errorStatus" : s.status}`)}
                      </StatusChip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ingest API docs */}
        <div className="rounded-md border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
              <Terminal className="size-4 text-emerald-600 dark:text-emerald-400" /> {T("sources.ingestApi")}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <StatusChip tone="muted">
                {T("sources.rateLimit")}: <span dir="ltr" className="sg-num">{settings.data?.rateLimitPerMin ?? "—"}</span>/min
              </StatusChip>
              <StatusChip tone="muted">
                {T("sources.batchLimit")}: <span dir="ltr" className="sg-num">{settings.data?.maxBatchSize ?? "—"}</span>
              </StatusChip>
              <StatusChip tone="muted">4KB / 256KB</StatusChip>
            </div>
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">{T("sources.ingestApiDesc")}</p>
          <pre dir="ltr" className="sg-json overflow-x-auto rounded-md border border-border bg-[#0C110F] p-3 font-mono text-[10.5px] leading-relaxed text-emerald-200/90">
            {CURL_EXAMPLE}
          </pre>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {T("sources.demoKey")}: <code dir="ltr" className="sg-num rounded border border-amber-500/50 bg-amber-400/10 px-1 py-px text-[10px] text-amber-700 dark:border-amber-400/40 dark:bg-transparent dark:text-amber-300">demo-key-01</code>
          </p>
        </div>

        {/* test event + scenarios */}
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-1 text-[13px] font-medium">{T("sources.testEvent")}</h3>
            <p className="mb-3 text-[11px] text-muted-foreground">{T("sources.testEventDesc")}</p>
            {canIngest ? (
              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <Label className="text-[11px]">{T("sources.sourceId")}</Label>
                  <Input
                    dir="ltr"
                    value={form.sourceId}
                    onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">{T("common.severity")}</Label>
                  <Select value={form.severity} onValueChange={(v) => setForm((f) => ({ ...f, severity: v as Severity }))}>
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
                <div className="space-y-1">
                  <Label className="text-[11px]">{T("common.category")}</Label>
                  <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                    <SelectTrigger size="sm" className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c} className="font-mono text-xs">{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">{T("common.message")}</Label>
                  <Input
                    value={form.message}
                    onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                    placeholder={T("sources.messagePlaceholder")}
                    className="h-8 text-xs"
                    maxLength={512}
                  />
                </div>
                <div className="col-span-2 flex justify-end">
                  <Button size="sm" className="h-8" disabled={sending || !form.sourceId.trim()} onClick={sendTest}>
                    {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                    {sending ? T("common.sending") : T("common.send")}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                {T("common.analystPlus")}
              </p>
            )}
          </div>

          {/* scenarios */}
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="mb-1 text-[13px] font-medium">{T("sources.scenarios")}</h3>
            <p className="mb-3 text-[11px] text-muted-foreground">{T("sources.scenariosDesc")}</p>
            {canIngest ? (
              scenarios.isLoading ? (
                <p className="text-xs text-muted-foreground">{T("common.loading")}</p>
              ) : (scenarios.data ?? []).length > 0 ? (
                <ScenarioRunButtons user={user} />
              ) : (
                <p className="text-xs text-muted-foreground">{T("states.empty")}</p>
              )
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                {T("common.analystPlus")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
