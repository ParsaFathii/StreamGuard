"use client";

// StreamGuard Console — database backup panel (Settings; console edition, ADMIN).
// Lists rotating SQLite snapshots, shows the automatic schedule state and lets
// an ADMIN take a snapshot now. Restore stays a manual documented procedure.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DatabaseBackup, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError, IS_CONSOLE_EDITION } from "@/lib/api-client";
import { Badge, EmptyState, useT } from "./primitives";
import { TimeAgo } from "./time";

function fmtMB(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

export function BackupPanel({ admin }: { admin: boolean }) {
  const T = useT();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ["backups"],
    queryFn: api.backups,
    enabled: admin && IS_CONSOLE_EDITION,
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: api.createBackup,
    onMutate: () => setCreating(true),
    onSuccess: (d) => {
      toast.success(T("backups.createOk", { file: d.file ?? "?", mb: fmtMB(d.sizeBytes ?? 0) }));
      qc.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (err: Error) => {
      const ae = err as ApiError;
      toast.error(T("backups.createFail", { msg: ae.message }));
    },
    onSettled: () => setCreating(false),
  });

  if (!IS_CONSOLE_EDITION || !admin) return null;

  const data = list.data;
  const result = data?.lastResult;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium">
        <DatabaseBackup className="size-4" /> {T("backups.title")}
      </h3>
      <p className="mb-3 text-[11px] text-muted-foreground">{T("backups.desc")}</p>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge variant="outline" className="border-border font-normal text-muted-foreground">
          {T("backups.schedule")}
        </Badge>
        <Badge variant="outline" className="border-border font-normal text-muted-foreground">
          {T("backups.keep")}: {data?.keep ?? 7}
        </Badge>
        {data?.lastRunAt ? (
          <span className="text-muted-foreground">
            {T("backups.lastRun")}: <TimeAgo iso={data.lastRunAt} className="sg-num" />
            {result ? (
              result.ok ? (
                <span className="ms-1 text-emerald-600 dark:text-emerald-400">· {T("backups.resultOk")}</span>
              ) : (
                <span className="ms-1 text-rose-600 dark:text-rose-400">· {T("backups.resultFail")}</span>
              )
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {T("backups.lastRun")}: {T("backups.never")}
          </span>
        )}
      </div>

      {list.isLoading ? (
        <p className="mb-3 text-[11px] text-muted-foreground">…</p>
      ) : list.isError ? (
        <p className="mb-3 text-[11px] text-rose-600 dark:text-rose-400">{(list.error as Error).message}</p>
      ) : !data || data.backups.length === 0 ? (
        <div className="mb-3">
          <EmptyState title={T("backups.empty")} />
        </div>
      ) : (
        <div className="mb-3 max-h-56 overflow-y-auto rounded-md border border-border" role="region" aria-label={T("backups.title")}>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="sticky top-0 border-b border-border bg-muted/40 text-muted-foreground">
                <th scope="col" className="px-2 py-1.5 text-start font-medium">{T("backups.name")}</th>
                <th scope="col" className="px-2 py-1.5 text-end font-medium">{T("backups.size")}</th>
                <th scope="col" className="px-2 py-1.5 text-end font-medium">{T("backups.when")}</th>
              </tr>
            </thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.name} className="border-b border-border/60 last:border-0">
                  <td dir="ltr" className="px-2 py-1.5 font-mono text-[10.5px]">{b.name}</td>
                  <td dir="ltr" className="px-2 py-1.5 text-end sg-num">{fmtMB(b.sizeBytes)} MB</td>
                  <td className="px-2 py-1.5 text-end">
                    <TimeAgo iso={b.createdAt} className="sg-num" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" disabled={creating} onClick={() => create.mutate()}>
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <DatabaseBackup className="size-3.5" />}
          {creating ? T("backups.creating") : T("backups.create")}
        </Button>
        <p className="max-w-md text-[10.5px] text-muted-foreground">
          <span className="font-medium">{T("backups.restoreTitle")}</span> {T("backups.restoreSteps")}
        </p>
      </div>
    </div>
  );
}
