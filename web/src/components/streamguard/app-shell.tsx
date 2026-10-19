"use client";

// StreamGuard Console — application shell:
// top bar + left rail + section viewport + sticky status footer + mobile tab bar.
// Also hosts the WS bridge (connection state, live invalidations, stats) and keyboard shortcuts.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  ChevronDown,
  LogOut,
  Menu,
  Moon,
  Sun,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { api } from "@/lib/api-client";
import { connectLive, useLiveChannel } from "@/lib/ws";
import { SECTION_IDS, useUiStore, type SectionId } from "@/lib/store";
import type { OverviewResponse, SessionUser } from "@/lib/types";
import { ConnectionBadge, useT } from "./primitives";
import { NAV_ITEMS, MOBILE_TAB_IDS } from "./nav";
import { SectionRouter } from "./section-router";

/* ------------------------------ user chip ------------------------------- */

/**
 * Display name without a redundant role parenthetical — the role is always
 * shown as its own badge next to the name (never truncated). Seeded demo
 * display names carry “(Admin)” etc.; stripping the duplicate at DISPLAY time
 * only (the full original name stays in tooltips and the login session).
 */
function chipName(user: SessionUser): string {
  const stripped = user.displayName.replace(/\s*\((Admin|Analyst|Viewer)\)\s*$/i, "").trim();
  return stripped.length > 0 ? stripped : user.displayName;
}

function UserAvatar({ user, className }: { user: SessionUser; className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex size-6 items-center justify-center rounded-md bg-secondary font-mono text-[10px] font-semibold uppercase ${className ?? ""}`}
    >
      {chipName(user).slice(0, 2)}
    </span>
  );
}

/** Role badge used next to user names — always uppercase, never truncated. */
function RoleBadge({ role, className }: { role: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={`shrink-0 border-emerald-600/40 bg-emerald-500/10 font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400 ${className ?? ""}`}
    >
      {role}
    </Badge>
  );
}

/** Shared dropdown body for the top-bar chip and the rail avatar. */
function UserMenuContent({ user }: { user: SessionUser }) {
  const T = useT();
  const qc = useQueryClient();

  const switchRole = async (username: string) => {
    try {
      const res = await api.login(username, `${username}123`);
      qc.setQueryData(["session"], res);
      qc.invalidateQueries();
      toast.success(T("toasts.loggedIn", { name: res.user.displayName, role: res.user.role }));
    } catch {
      toast.error(T("toasts.loginFailed"));
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* best effort */
    }
    qc.clear();
    toast(T("toasts.loggedOut"));
  };

  return (
    <DropdownMenuContent align="start" className="w-56">
      <DropdownMenuLabel className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-[13px]" title={user.displayName}>
            {chipName(user)}
          </span>
          <span dir="ltr" className="block truncate font-mono text-[11px] text-muted-foreground">
            @{user.username}
          </span>
        </span>
        <RoleBadge role={user.role} className="!text-[10px]" />
      </DropdownMenuLabel>
      {user.role === "ADMIN" && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">{T("topbar.switchRole")}</DropdownMenuLabel>
          {(["analyst", "viewer"] as const).map((u) => (
            <DropdownMenuItem key={u} onClick={() => switchRole(u)} className="gap-2 font-mono text-xs">
              <UserRound className="size-3.5" /> {u}
            </DropdownMenuItem>
          ))}
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={logout} className="gap-2 text-xs">
        <LogOut className="size-3.5" /> {T("topbar.logout")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

/* --------------------------- live stats helper --------------------------- */

function useLiveMicroStats() {
  const { data: overview } = useQuery<OverviewResponse>({
    queryKey: ["overview"],
    queryFn: api.analyticsOverview,
    refetchInterval: 30_000,
  });
  const liveStats = useUiStore((s) => s.liveStats);

  const ingestPerMin = useMemo(() => {
    if (typeof liveStats?.ingestPerMin === "number") return liveStats.ingestPerMin;
    const rates = overview?.ingestRatePerMin ?? [];
    if (!rates.length) return null;
    const last = rates.slice(-5);
    return Math.round(last.reduce((s, r) => s + r.count, 0) / last.length);
  }, [overview, liveStats]);

  return {
    ingestPerMin,
    openIncidents: liveStats?.incidentsOpen ?? overview?.totals.incidentsOpen ?? null,
    detections24h: liveStats?.detections24h ?? overview?.totals.detections24h ?? null,
  };
}

/* ------------------------------ WS bridge ------------------------------- */

function useLiveBridge() {
  const qc = useQueryClient();
  const lastRun = useRef<Record<string, number>>({});
  const seenRuns = useRef<Set<string>>(new Set());

  const throttled = useCallback(
    (keys: string[], minGapMs: number) => {
      const storeKey = keys.join("|");
      const now = Date.now();
      if (now - (lastRun.current[storeKey] ?? 0) < minGapMs) return;
      lastRun.current[storeKey] = now;
      keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    [qc],
  );

  useLiveChannel("event:new", () => {
    useUiStore.getState().setLastWsEventAt(new Date().toISOString());
    throttled(["events", "overview", "sources"], 2_500);
  });
  useLiveChannel("detection:new", () => {
    throttled(["detections", "overview", "rules", "ml"], 2_500);
  });
  useLiveChannel("incident:new", () => throttled(["incidents", "overview"], 2_000));
  useLiveChannel("incident:update", () => throttled(["incidents", "incident", "overview"], 1_000));
  useLiveChannel("stats", (payload) => {
    useUiStore.getState().setLiveStats({ ...(payload as Record<string, number>), ts: new Date().toISOString() });
  });
  useLiveChannel("simulator", (payload) => {
    const p = payload as { runId?: string; scenarioId?: string; phase?: string };
    if (p?.runId) {
      if (p.phase === "done" && seenRuns.current.has(p.runId)) {
        seenRuns.current.delete(p.runId);
      } else if (!seenRuns.current.has(p.runId) && (p.phase === "start" || p.phase === "queued")) {
        seenRuns.current.add(p.runId);
      }
    }
    throttled(["overview", "events", "detections", "incidents", "rules", "ml", "sources", "health"], 3_000);
  });
}

/* -------------------------- keyboard shortcuts --------------------------- */

function useKeyboardShortcuts() {
  const setSection = useUiStore((s) => s.setSection);
  const setFocusEventsSearch = useUiStore((s) => s.setFocusEventsSearch);

  useEffect(() => {
    let armed = false;
    let armTimer: ReturnType<typeof setTimeout> | null = null;

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);

      if (e.key === "Escape") {
        armed = false;
        return;
      }
      if (editing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/") {
        e.preventDefault();
        setSection("events");
        setFocusEventsSearch(true);
        return;
      }
      if (e.key === "g" || e.key === "G") {
        armed = true;
        if (armTimer) clearTimeout(armTimer);
        armTimer = setTimeout(() => (armed = false), 1_400);
        return;
      }
      if (armed && /^[0-9]$/.test(e.key)) {
        armed = false;
        const idx = e.key === "0" ? 9 : Number(e.key) - 1;
        const section = SECTION_IDS[idx];
        if (section) {
          e.preventDefault();
          setSection(section);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (armTimer) clearTimeout(armTimer);
    };
  }, [setSection, setFocusEventsSearch]);
}

/* -------------------------------- Rail ----------------------------------- */

function Rail({ user }: { user: SessionUser }) {
  const T = useT();
  const activeSection = useUiStore((s) => s.activeSection);
  const setSection = useUiStore((s) => s.setSection);
  const wsStatus = useUiStore((s) => s.wsStatus);
  const apiVersion = useUiStore((s) => s.apiVersion);

  return (
    <nav
      aria-label={T("nav.sections")}
      className="relative z-10 hidden w-14 shrink-0 flex-col border-e border-border bg-sidebar md:flex xl:w-56"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3 xl:px-4">
        <div className="sg-brand sg-pulse flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-bold">
          SG
        </div>
        <span className="hidden min-w-0 truncate text-[13px] font-semibold xl:block">StreamGuard</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <ul className="flex flex-col gap-0.5 px-2">
          {NAV_ITEMS.map((item) => {
            const active = activeSection === item.id;
            const Icon = item.icon;
            const btn = (
              <button
                type="button"
                onClick={() => setSection(item.id)}
                aria-current={active ? "page" : undefined}
                className={`group relative flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-start outline-none transition-colors xl:h-9 ${
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                {active && <span aria-hidden className="absolute start-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />}
                <Icon className={`size-4 shrink-0 ${active ? "text-primary" : ""}`} />
                <span className="hidden min-w-0 truncate text-[13px] xl:block">{T(item.labelKey)}</span>
              </button>
            );
            return (
              <li key={item.id}>
                <Tooltip>
                  <TooltipTrigger asChild>{btn}</TooltipTrigger>
                  <TooltipContent side="right" className="xl:hidden">
                    <p className="text-xs font-medium">{T(item.labelKey)}</p>
                    <p className="max-w-52 text-[11px] text-muted-foreground">{T(item.descKey)}</p>
                  </TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </div>

      {/* bottom block: user chip + connection state + version, with room to breathe */}
      <div className="shrink-0 border-t border-border p-3">
        <div className="mb-3 flex items-center gap-2.5">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={T("topbar.userMenu")}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary/60 transition-colors hover:bg-secondary"
                  >
                    <UserAvatar user={user} className="!size-auto !bg-transparent text-xs" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="right" className="xl:hidden">
                <p className="text-xs font-medium">{chipName(user)}</p>
                <p dir="ltr" className="font-mono text-[10px] text-muted-foreground">
                  @{user.username}
                </p>
              </TooltipContent>
            </Tooltip>
            <UserMenuContent user={user} />
          </DropdownMenu>
          <div className="hidden min-w-0 flex-col gap-0.5 xl:flex">
            <span className="truncate text-[12px] font-medium leading-tight" title={user.displayName}>
              {chipName(user)}
            </span>
            <span dir="ltr" className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
              {user.role} · @{user.username}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2" role="status">
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${
                wsStatus === "live" ? "bg-emerald-500 sg-pulse" : wsStatus === "reconnecting" ? "bg-amber-400" : "bg-rose-500"
              }`}
            />
            <span className="hidden min-w-0 truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground xl:block">
              {wsStatus === "live" ? T("topbar.live") : wsStatus}
            </span>
          </span>
          <span dir="ltr" className="shrink-0 font-mono text-[10px] text-muted-foreground">
            v{apiVersion ? apiVersion.replace(/^v/, "") : "10.3.2"}
          </span>
        </div>
      </div>
    </nav>
  );
}

/* ------------------------------- Top bar --------------------------------- */

function TopBar({ user }: { user: SessionUser }) {
  const T = useT();
  const { theme, setTheme } = useTheme();
  const activeSection = useUiStore((s) => s.activeSection);
  const lang = useUiStore((s) => s.lang);
  const setLang = useUiStore((s) => s.setLang);
  const setSection = useUiStore((s) => s.setSection);
  const setFocusEventsSearch = useUiStore((s) => s.setFocusEventsSearch);
  const stats = useLiveMicroStats();

  const nav = NAV_ITEMS.find((n) => n.id === activeSection);
  const title = nav ? T(nav.labelKey) : activeSection;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3 sm:px-4">
      {/* Mobile brand */}
      <div className="sg-brand flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-bold md:hidden">
        SG
      </div>

      <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>

      {/* search hint */}
      <button
        type="button"
        onClick={() => {
          setSection("events");
          setFocusEventsSearch(true);
        }}
        className="ms-1 hidden h-7 items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-[var(--sg-border-strong)] hover:text-foreground lg:flex"
        aria-label={T("topbar.search")}
      >
        <span>{T("topbar.search")}</span>
        <span className="sg-kbd">/</span>
      </button>

      <div className="flex-1" />

      {/* demo chip */}
      <Badge
        variant="outline"
        className="hidden border-amber-500/50 bg-transparent font-mono text-[10px] font-semibold tracking-wide text-amber-600 dark:border-amber-400/40 dark:text-amber-300 sm:inline-flex"
      >
        {T("topbar.demoChip")}
      </Badge>

      {/* live micro-stats */}
      <div className="hidden items-center gap-3 font-mono text-[11px] text-muted-foreground xl:flex" dir="ltr">
        <span>
          <span className="text-foreground">{stats.ingestPerMin ?? "—"}</span> {T("topbar.ingestPerMin")}
        </span>
        <span className="text-border">|</span>
        <span>
          <span className="text-amber-600 dark:text-amber-300">{stats.openIncidents ?? "—"}</span> {T("topbar.openIncidents")}
        </span>
        <span className="text-border">|</span>
        <span>
          <span className="text-foreground">{stats.detections24h ?? "—"}</span> {T("topbar.detections24h")}
        </span>
      </div>

      <ConnectionBadge />

      {/* language toggle */}
      <div className="flex h-7 items-center rounded-md border border-border text-[11px]" role="group" aria-label={T("topbar.language")}>
        <button
          type="button"
          onClick={() => setLang("en")}
          aria-pressed={lang === "en"}
          className={`h-full px-2 font-medium transition-colors ${lang === "en" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
        >
          EN
        </button>
        <button
          type="button"
          onClick={() => setLang("fa")}
          aria-pressed={lang === "fa"}
          className={`h-full px-2 font-medium transition-colors ${lang === "fa" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
        >
          فا
        </button>
      </div>

      {/* theme toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={T("topbar.theme")}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <Sun className="size-4 dark:hidden" />
            <Moon className="hidden size-4 dark:block" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{T("topbar.theme")}</TooltipContent>
      </Tooltip>

      {/* user menu — display name (1 line, tooltip) + role badge that never truncates */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 gap-2 px-1.5" aria-label={T("topbar.userMenu")}>
            <UserAvatar user={user} />
            <span className="hidden max-w-36 truncate text-xs sm:block" title={user.displayName}>
              {chipName(user)}
            </span>
            <RoleBadge role={user.role} className="hidden sm:inline-flex" />
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <UserMenuContent user={user} />
      </DropdownMenu>
    </header>
  );
}

/* ------------------------------ Status footer ----------------------------- */

function FooterBar() {
  const T = useT();
  const lastLatency = useUiStore((s) => s.lastLatencyMs);
  const apiVersion = useUiStore((s) => s.apiVersion);
  const liveStats = useUiStore((s) => s.liveStats);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 120_000 });

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-sidebar px-3 font-mono text-[10px] text-muted-foreground sm:px-4">
      <span className="text-emerald-600 dark:text-emerald-400">{apiVersion ? `v${apiVersion.replace(/^v/, "")}` : "v10.3.2"}</span>
      <span className="text-border">·</span>
      <span dir="ltr">
        {T("footer.latency")} {lastLatency !== null ? `${lastLatency}ms` : "—"}
      </span>
      <span className="text-border">·</span>
      <span dir="ltr">
        {T("footer.queueDepth")} {liveStats?.queueDepth ?? "—"}
      </span>
      <span className="hidden text-border sm:inline">·</span>
      <span dir="ltr" className="hidden sm:inline">
        {T("footer.retention")} {settings?.retentionHours ?? "—"}h
      </span>
      <span className="flex-1" />
      <span className="hidden sm:inline">
        {T("footer.copyright")} · {T("footer.license")}
      </span>
      <span className="sm:hidden">{T("footer.copyright")}</span>
    </footer>
  );
}

/* ------------------------------ Mobile tabs ------------------------------- */

function MobileTabBar() {
  const T = useT();
  const activeSection = useUiStore((s) => s.activeSection);
  const setSection = useUiStore((s) => s.setSection);

  return (
    <nav
      aria-label={T("nav.sections")}
      className="flex h-14 shrink-0 items-stretch border-t border-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {MOBILE_TAB_IDS.map((id) => {
        const item = NAV_ITEMS.find((n) => n.id === id)!;
        const Icon = item.icon;
        const active = activeSection === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[10px] ${
              active ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <Icon className="size-5" />
            <span className="max-w-full truncate px-1">{T(item.labelKey)}</span>
          </button>
        );
      })}

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground"
            aria-label={T("nav.more")}
          >
            <Menu className="size-5" />
            <span>{T("nav.more")}</span>
          </button>
        </SheetTrigger>
        <SheetContent side="bottom" className="max-h-[70vh] overflow-y-auto px-3 pb-6 pt-3">
          <SheetHeader className="px-0 pb-2">
            <SheetTitle className="text-sm">{T("nav.sections")}</SheetTitle>
          </SheetHeader>
          <ul className="grid grid-cols-2 gap-1.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeSection === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSection(item.id)}
                    className={`flex min-h-11 w-full items-center gap-2.5 rounded-md border px-3 text-[13px] transition-colors ${
                      active ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-secondary/40 hover:bg-secondary"
                    }`}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{T(item.labelKey)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </nav>
  );
}

/* -------------------------------- Shell ----------------------------------- */

export function AppShell({ user }: { user: SessionUser }) {
  const activeSection = useUiStore((s) => s.activeSection);

  useEffect(() => connectLive(), []);
  useLiveBridge();
  useKeyboardShortcuts();

  return (
    <div className="flex h-dvh min-h-dvh flex-col overflow-hidden bg-background">
      <TopBar user={user} />
      <div className="flex min-h-0 flex-1">
        <Rail user={user} />
        <main id="main" className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1600px] px-3 py-4 sm:px-5">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeSection}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              >
                <SectionRouter user={user} />
              </motion.div>
            </AnimatePresence>
            <div className="h-6" />
          </div>
        </main>
      </div>
      <FooterBar />
      <MobileTabBar />
    </div>
  );
}
