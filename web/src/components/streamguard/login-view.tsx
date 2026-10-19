"use client";

// StreamGuard Console — login view with demo account quick-select.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Loader2, ShieldCheck, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api-client";
import type { SessionUser } from "@/lib/types";
import { useT } from "./primitives";

const DEMO_ACCOUNTS = [
  { username: "admin", password: "admin123", role: "ADMIN" as const, descKey: "login.adminDesc" },
  { username: "analyst", password: "analyst123", role: "ANALYST" as const, descKey: "login.analystDesc" },
  { username: "viewer", password: "viewer123", role: "VIEWER" as const, descKey: "login.viewerDesc" },
];

export function LoginView() {
  const T = useT();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doLogin = async (u: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(u, p);
      qc.setQueryData<{ user: SessionUser }>(["session"], res);
      qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : T("login.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="w-full max-w-sm"
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="sg-brand sg-pulse flex size-12 items-center justify-center rounded-lg font-mono text-lg font-bold">
            SG
          </div>
          <div>
            <h1 className="text-lg font-semibold">{T("app.name")}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{T("app.subtitle")}</p>
          </div>
        </div>

        <form
          className="rounded-lg border border-border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) doLogin(username, password);
          }}
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="login-username" className="text-xs">
                {T("login.username")}
              </Label>
              <Input
                id="login-username"
                autoComplete="username"
                dir="ltr"
                className="h-9 font-mono text-[13px]"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password" className="text-xs">
                {T("login.password")}
              </Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                dir="ltr"
                className="h-9 font-mono text-[13px]"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="mt-3 rounded-md border border-rose-600/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-600 dark:border-rose-500/25 dark:text-rose-400">
              {error}
            </p>
          )}

          <Button type="submit" className="mt-4 h-9 w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {busy ? T("login.signingIn") : T("login.signIn")}
          </Button>

          <div className="mt-5 border-t border-border pt-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {T("login.demoAccounts")}
            </p>
            <div className="space-y-1.5">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.username}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setUsername(acc.username);
                    setPassword(acc.password);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-start transition-colors hover:border-[var(--sg-border-strong)] hover:bg-secondary disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span dir="ltr" className="sg-num block text-xs font-medium">
                      {acc.username} / {acc.password}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">{T(acc.descKey)}</span>
                  </span>
                  <Badge variant="outline" className="shrink-0 border-emerald-600/40 bg-emerald-500/10 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400">
                    {acc.role}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        </form>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          {T("login.notice")}
        </p>
      </motion.div>
    </div>
  );
}
