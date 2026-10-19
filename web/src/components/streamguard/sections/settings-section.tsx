"use client";

// StreamGuard Console — Section 14: Settings (role-aware forms + danger zone).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { AlertTriangle, Check, Loader2, Save, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api, ApiError } from "@/lib/api-client";
import type { SgSettings, SessionUser } from "@/lib/types";
import { isAdmin, useUiStore } from "@/lib/store";
import { SectionHeader, SkeletonCards, useT } from "../primitives";

export function SettingsSection({ user }: { user: SessionUser }) {
  const T = useT();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const lang = useUiStore((s) => s.lang);
  const setLang = useUiStore((s) => s.setLang);
  const admin = isAdmin(user.role);

  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  const [form, setForm] = useState<SgSettings | null>(null);
  const [initialized, setInitialized] = useState(false);
  // render-phase one-time init from server settings (avoids effect cascades)
  if (settings.data && !initialized) {
    setInitialized(true);
    setForm(settings.data);
  }

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<SgSettings>) => api.patchSettings(patch),
    onSuccess: (next) => {
      toast.success(T("toasts.settingsSaved"));
      qc.setQueryData(["settings"], next);
      setForm(next);
    },
    onError: (err: Error) =>
      toast.error((err as ApiError).status === 403 ? T("toasts.forbidden") : T("toasts.settingsSaveFailed")),
  });

  const resetMutation = useMutation({
    mutationFn: () => api.resetSimulator(),
    onSuccess: () => {
      toast.success(T("toasts.resetDone"));
      qc.invalidateQueries();
    },
    onError: (err: Error) =>
      toast.error((err as ApiError).status === 403 ? T("toasts.forbidden") : T("toasts.resetFailed")),
  });

  const num = (v: string) => Number(v.replace(/[^\d]/g, "")) || 0;

  const field = (
    label: string,
    hint: string,
    node: React.ReactNode,
    editable: boolean,
  ) => (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-2 text-xs">
        {label}
        {!editable && (
          <Badge variant="outline" className="border-border font-mono text-[9px] text-muted-foreground">
            {T("common.readOnly")}
          </Badge>
        )}
      </Label>
      {node}
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );

  const roleMatrix = [
    { cap: T("caps.viewData"), admin: true, analyst: true, viewer: true },
    { cap: T("caps.editRules"), admin: true, analyst: true, viewer: false },
    { cap: T("caps.triageIncidents"), admin: true, analyst: true, viewer: false },
    { cap: T("caps.aiInvestigate"), admin: true, analyst: true, viewer: false },
    { cap: T("caps.runSimulator"), admin: true, analyst: true, viewer: false },
    { cap: T("caps.mlEvaluate"), admin: true, analyst: true, viewer: false },
    { cap: T("caps.settings"), admin: true, analyst: false, viewer: false },
    { cap: T("caps.audit"), admin: true, analyst: false, viewer: false },
    { cap: T("caps.retentionRun"), admin: true, analyst: false, viewer: false },
    { cap: T("caps.resetDemo"), admin: true, analyst: false, viewer: false },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader title={T("settings.title")} desc={T("navDesc.settings")} />

      {settings.isLoading ? (
        <SkeletonCards count={4} />
      ) : !form ? (
        <p className="text-xs text-muted-foreground">{T("states.errorBody")}</p>
      ) : (
        <>
          {/* session + appearance */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-3 text-[13px] font-medium">{T("settings.sessionCard")}</h3>
              <div className="flex items-center justify-between gap-2 text-xs">
                <div>
                  <p className="font-medium">{user.displayName}</p>
                  <p dir="ltr" className="sg-num text-muted-foreground">@{user.username}</p>
                </div>
                <Badge variant="outline" className="border-emerald-600/40 bg-emerald-500/10 font-mono text-[10px] text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400">
                  {user.role}
                </Badge>
              </div>
              <Separator className="my-3" />
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs">{T("settings.theme")}</span>
                  <div className="flex h-7 items-center rounded-md border border-border text-[11px]" role="group" aria-label={T("settings.theme")}>
                    <button
                      type="button"
                      onClick={() => setTheme("dark")}
                      aria-pressed={theme === "dark"}
                      className={`h-full px-2.5 font-medium transition-colors ${theme === "dark" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                    >
                      {T("settings.dark")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTheme("light")}
                      aria-pressed={theme === "light"}
                      className={`h-full px-2.5 font-medium transition-colors ${theme === "light" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                    >
                      {T("settings.light")}
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs">{T("topbar.language")}</span>
                  <div className="flex h-7 items-center rounded-md border border-border text-[11px]" role="group" aria-label={T("topbar.language")}>
                    <button
                      type="button"
                      onClick={() => setLang("en")}
                      aria-pressed={lang === "en"}
                      className={`h-full px-2.5 font-medium transition-colors ${lang === "en" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                    >
                      EN
                    </button>
                    <button
                      type="button"
                      onClick={() => setLang("fa")}
                      aria-pressed={lang === "fa"}
                      className={`h-full px-2.5 font-medium transition-colors ${lang === "fa" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                    >
                      فا
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">{T("settings.localOnly")}</p>
              </div>
            </div>

            {/* AI */}
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-3 text-[13px] font-medium">{T("settings.aiSection")}</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ai-enabled" className="text-xs">
                    {T("settings.aiEnabled")}
                  </Label>
                  <Switch
                    id="ai-enabled"
                    checked={form.aiEnabled}
                    disabled={!admin || saveMutation.isPending}
                    onCheckedChange={(c) => {
                      setForm({ ...form, aiEnabled: c });
                      saveMutation.mutate({ aiEnabled: c });
                    }}
                  />
                </div>
                {field(
                  T("settings.aiProvider"),
                  "sandbox-zai · ollama (demo: sandbox)",
                  <Input
                    dir="ltr"
                    value={form.aiProvider}
                    disabled={!admin}
                    onChange={(e) => setForm({ ...form, aiProvider: e.target.value })}
                    className="h-8 font-mono text-xs"
                  />,
                  admin,
                )}
                {admin && (
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={saveMutation.isPending || form.aiProvider === settings.data?.aiProvider}
                    onClick={() => saveMutation.mutate({ aiProvider: form.aiProvider })}
                  >
                    {saveMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    {T("common.save")}
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* engine settings */}
          <div className="rounded-md border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[13px] font-medium">{T("settings.engine")}</h3>
              {!admin && <span className="text-[10px] text-muted-foreground">{T("settings.editableHint")}</span>}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {field(
                T("settings.correlationWindow"),
                T("settings.correlationWindowHint"),
                <Input
                  dir="ltr"
                  type="number"
                  min={10}
                  max={3600}
                  value={form.correlationWindowSeconds}
                  disabled={!admin}
                  onChange={(e) => setForm({ ...form, correlationWindowSeconds: num(e.target.value) })}
                  className="h-8 font-mono text-xs"
                />,
                admin,
              )}
              {field(
                T("settings.retentionHours"),
                T("settings.retentionHint"),
                <Input
                  dir="ltr"
                  type="number"
                  min={1}
                  max={720}
                  value={form.retentionHours}
                  disabled={!admin}
                  onChange={(e) => setForm({ ...form, retentionHours: num(e.target.value) })}
                  className="h-8 font-mono text-xs"
                />,
                admin,
              )}
              {field(
                T("settings.rateLimit"),
                T("settings.rateLimitHint"),
                <Input
                  dir="ltr"
                  type="number"
                  min={1}
                  max={6000}
                  value={form.rateLimitPerMin}
                  disabled={!admin}
                  onChange={(e) => setForm({ ...form, rateLimitPerMin: num(e.target.value) })}
                  className="h-8 font-mono text-xs"
                />,
                admin,
              )}
              {field(
                T("settings.batchSize"),
                T("settings.batchSizeHint"),
                <Input
                  dir="ltr"
                  type="number"
                  min={1}
                  max={100}
                  value={form.maxBatchSize}
                  disabled={!admin}
                  onChange={(e) => setForm({ ...form, maxBatchSize: num(e.target.value) })}
                  className="h-8 font-mono text-xs"
                />,
                admin,
              )}
              {field(
                T("settings.languageDefault"),
                `${T("settings.localOnly")}`,
                <Select
                  value={form.languageDefault}
                  disabled={!admin}
                  onValueChange={(v) => {
                    const next = { ...form, languageDefault: v as "en" | "fa" };
                    setForm(next);
                    saveMutation.mutate({ languageDefault: v as "en" | "fa" });
                  }}
                >
                  <SelectTrigger size="sm" className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en" className="text-xs">English</SelectItem>
                    <SelectItem value="fa" className="text-xs">فارسی</SelectItem>
                  </SelectContent>
                </Select>,
                admin,
              )}
            </div>
            {admin && (
              <div className="mt-4 flex justify-end border-t border-border pt-3">
                <Button
                  size="sm"
                  disabled={saveMutation.isPending}
                  onClick={() =>
                    saveMutation.mutate({
                      correlationWindowSeconds: form.correlationWindowSeconds,
                      retentionHours: form.retentionHours,
                      rateLimitPerMin: form.rateLimitPerMin,
                      maxBatchSize: form.maxBatchSize,
                    })
                  }
                >
                  {saveMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  {saveMutation.isPending ? T("common.saving") : T("common.save")}
                </Button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {/* role matrix */}
            <div className="rounded-md border border-border bg-card p-4">
              <h3 className="mb-3 text-[13px] font-medium">{T("settings.roleMatrix")}</h3>
              <div className="overflow-x-auto">
                <table className="sg-table w-full">
                  <thead>
                    <tr className="border-b border-border text-start">
                      <th scope="col" className="text-start text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {T("roles.capability")}
                      </th>
                      <th scope="col" className="px-2 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">ADMIN</th>
                      <th scope="col" className="px-2 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">ANALYST</th>
                      <th scope="col" className="px-2 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">VIEWER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roleMatrix.map((r) => (
                      <tr key={r.cap} className="border-b border-border/50">
                        <td className="py-1.5 text-xs">{r.cap}</td>
                        {[r.admin, r.analyst, r.viewer].map((v, i) => (
                          <td key={i} className="px-2 py-1.5 text-center">
                            {v ? (
                              <Check className="mx-auto size-3.5 text-emerald-600 dark:text-emerald-400" />
                            ) : (
                              <span className="text-muted-foreground/40">—</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* danger zone */}
            <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.03] p-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-rose-600 dark:text-rose-400">
                <ShieldAlert className="size-4" /> {T("settings.dangerZone")}
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground">{T("settings.resetDemoHint")}</p>
              {admin ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" disabled={resetMutation.isPending}>
                      {resetMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <AlertTriangle className="size-3.5" />}
                      {T("settings.resetDemo")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-sm">{T("settings.resetConfirmTitle")}</AlertDialogTitle>
                      <AlertDialogDescription className="text-xs">{T("settings.resetConfirmBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="h-8 text-xs">{T("common.cancel")}</AlertDialogCancel>
                      <AlertDialogAction
                        className="h-8 bg-destructive text-xs text-white hover:bg-destructive/90"
                        onClick={(e) => {
                          e.preventDefault();
                          resetMutation.mutate();
                        }}
                      >
                        {T("settings.resetConfirmAction")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <p className="rounded-md border border-dashed border-rose-500/30 px-3 py-3 text-center text-[11px] text-muted-foreground">
                  {T("common.adminOnly")}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
