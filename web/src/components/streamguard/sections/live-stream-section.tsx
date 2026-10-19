"use client";

// StreamGuard Console — Section 3: Live Event Stream (the wall).
import { useEffect, useRef, useState, useCallback } from "react";
import { Eraser, Gauge, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CATEGORIES, SEVERITIES, type LiveEventPayload, type Severity, type SessionUser } from "@/lib/types";
import { normalizeEventNewPayload, useLiveChannel, type EventNewPayload } from "@/lib/ws";
import { useUiStore } from "@/lib/store";
import {
  EmptyState,
  OriginBadge,
  SectionHeader,
  SeverityDot,
  severityAtLeast,
  useT,
} from "../primitives";
import { fmtTime } from "../time";
import { GenerateActivityButton } from "../simulator";

const MAX_WALL = 500;

export function LiveStreamSection({ user }: { user?: SessionUser | null }) {
  const T = useT();
  const wsStatus = useUiStore((s) => s.wsStatus);

  const [events, setEvents] = useState<LiveEventPayload[]>([]);
  const [paused, setPaused] = useState(false);
  const [minSeverity, setMinSeverity] = useState<Severity>("info");
  const [category, setCategory] = useState<string>("all");
  const [rate, setRate] = useState(0);

  const bufferRef = useRef<LiveEventPayload[]>([]);
  const timesRef = useRef<number[]>([]);
  const [bufferedCount, setBufferedCount] = useState(0);

  // `event:new` arrives as a BATCH {events:[], count, ts} (400 ms server-side
  // batching) — or, defensively, as a single compact event. Normalize, validate
  // each item (id + severity + timestamp) and push every valid event so a batch
  // of N counts as N on the wall and on the events/min meter.
  const push = useCallback((payload: EventNewPayload) => {
    const batch = normalizeEventNewPayload(payload);
    if (batch.length === 0) return;
    for (const ev of batch) {
      timesRef.current.push(Date.now());
      if (paused) {
        bufferRef.current.unshift(ev);
      } else {
        setEvents((prev) => {
          const next = [ev, ...prev];
          if (next.length > MAX_WALL) next.length = MAX_WALL;
          return next;
        });
      }
    }
    if (paused) {
      if (bufferRef.current.length > MAX_WALL) bufferRef.current.length = MAX_WALL;
      setBufferedCount(bufferRef.current.length);
    }
  }, [paused]);

  useLiveChannel("event:new", push);

  // events/min meter (count of received events in the trailing 60s)
  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      timesRef.current = timesRef.current.filter((t) => t >= cutoff);
      setRate(timesRef.current.length);
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const resume = () => {
    setPaused(false);
    setEvents((prev) => {
      const flush = bufferRef.current;
      bufferRef.current = [];
      setBufferedCount(0);
      const next = [...flush, ...prev];
      if (next.length > MAX_WALL) next.length = MAX_WALL;
      return next;
    });
  };

  const clear = () => {
    bufferRef.current = [];
    setBufferedCount(0);
    setEvents([]);
  };

  const visible = events.filter(
    (e) => severityAtLeast(e.severity, minSeverity) && (category === "all" || e.category === category),
  );

  return (
    <div className="flex h-full flex-col gap-3">
      <SectionHeader
        title={T("live.title")}
        desc={T("navDesc.live")}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-1 font-mono text-[11px]" dir="ltr">
              <Gauge className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">{rate}</span>
              <span className="text-muted-foreground">{T("live.eventsPerMin")}</span>
            </div>
            <Button size="sm" variant={paused ? "default" : "outline"} onClick={() => (paused ? resume() : setPaused(true))}>
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? T("live.resume") : T("live.pause")}
            </Button>
            <Button size="sm" variant="ghost" onClick={clear} disabled={!events.length && !bufferedCount}>
              <Eraser className="size-3.5" /> {T("live.clear")}
            </Button>
          </div>
        }
      />

      {wsStatus !== "live" && (
        <Alert className="border-amber-400/30 bg-amber-400/5 py-2">
          <AlertDescription className="text-xs text-amber-700 dark:text-amber-300">
            {wsStatus === "reconnecting" ? T("live.reconnecting") : T("live.disconnected")}
          </AlertDescription>
        </Alert>
      )}

      {/* filters + status strip */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground" dir="ltr">
          {events.length}/{MAX_WALL} {T("live.received")}
          {paused && bufferedCount > 0 ? ` · ${bufferedCount} ${T("live.buffered")}` : ""}
        </span>
        <span className="flex-1" />
        {paused && (
          <span className="rounded border border-amber-500/50 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-700 dark:border-amber-400/40 dark:text-amber-300">
            {T("live.paused")}
          </span>
        )}
        <Select value={minSeverity} onValueChange={(v) => setMinSeverity(v as Severity)}>
          <SelectTrigger size="sm" className="h-7 w-32 text-xs" aria-label={T("live.minSeverity")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                ≥ {T(`sev.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger size="sm" className="h-7 w-32 text-xs" aria-label={T("common.category")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">{T("common.all")}</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c} className="font-mono text-xs">{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[10px] text-muted-foreground">{T("live.capNote")}</span>
      </div>

      {/* the wall */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-card">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-64 items-center justify-center p-6">
            <EmptyState
              title={paused && bufferedCount > 0 ? T("live.paused") : T("live.emptyTitle")}
              hint={T("live.emptyHint")}
              action={<GenerateActivityButton user={user} />}
              className="border-none"
            />
          </div>
        ) : (
          <ul className="h-full max-h-[calc(100dvh-320px)] min-h-64 overflow-y-auto">
            {visible.map((ev) => (
              <li
                key={ev.id}
                className="sg-row-in flex items-center gap-2.5 border-b border-border/50 px-3 py-1.5 text-xs transition-colors hover:bg-secondary/40"
              >
                <span dir="ltr" className="sg-num w-20 shrink-0 text-muted-foreground">
                  {fmtTime(ev.eventTime)}
                </span>
                <SeverityDot severity={ev.severity} />
                <span dir="ltr" title={ev.category} className="w-16 shrink-0 truncate font-mono text-[10px] text-muted-foreground">{ev.category}</span>
                <span dir="ltr" title={ev.sourceId} className="w-36 shrink-0 truncate font-mono text-[11px]">{ev.sourceId}</span>
                <span dir="ltr" title={ev.actor ?? "—"} className="hidden w-28 shrink-0 truncate font-mono text-[11px] text-muted-foreground lg:block">
                  {ev.actor ?? "—"}
                </span>
                <span title={ev.message} className="min-w-0 flex-1 truncate">{ev.message}</span>
                {ev.origin === "synthetic" && <OriginBadge origin={ev.origin} />}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">{T("live.syntheticNote")}</p>
    </div>
  );
}
