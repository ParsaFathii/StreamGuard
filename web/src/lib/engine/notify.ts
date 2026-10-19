// StreamGuard — server-side notifications to the socket.io mini-service (port 3003).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// The Next.js backend never talks to browsers directly over WS; it POSTs to the
// mini-service internal endpoint: POST http://127.0.0.1:3003/emit {channel, payload}.
// Fire-and-forget: if the stream service is down the API keeps working.
//
// Channels (server -> client):
// - "event:new"    payload {events: CompactEvent[], count, ts} — batched every 400 ms.
//                   CompactEvent = {id, eventTime, severity, category, sourceId, actor, message(<=140), origin}
// - "detection:new" payload = full detection object (incl. parsed detail)
// - "incident:new" / "incident:update" payload = incident summary object
// - "stats"        payload {events24h, detections24h, incidentsOpen, rejected24h, processed24h, lastEventAt, queueDepth} — every 5 s
// - "simulator"    payload {runId, scenarioId, phase: "start"|"done"}
import { db } from '@/lib/db'
import type { Severity, Category, Origin } from '@/lib/types'
import { maybeRunBackup } from '@/lib/engine/backups'

const STREAM_URL = 'http://127.0.0.1:3003'

export async function notify(channel: string, payload: unknown): Promise<void> {
  try {
    await fetch(`${STREAM_URL}/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, payload }),
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // fire-and-forget: stream service unavailable is non-fatal
  }
}

export interface CompactEvent {
  id: string
  eventTime: string
  severity: Severity
  category: Category
  sourceId: string
  actor: string | null
  message: string
  origin: Origin
}

export function compactEvent(e: {
  id: string
  eventTime: Date
  severity: string
  category: string
  sourceId: string
  actor: string | null
  message: string
  origin: string
}): CompactEvent {
  return {
    id: e.id,
    eventTime: e.eventTime.toISOString(),
    severity: e.severity as Severity,
    category: e.category as Category,
    sourceId: e.sourceId,
    actor: e.actor,
    message: e.message.length > 140 ? `${e.message.slice(0, 140)}…` : e.message,
    origin: e.origin as Origin,
  }
}

// ---- event:new batching (400 ms) ----
interface BatchState {
  pending: CompactEvent[]
  timer: ReturnType<typeof setTimeout> | null
}
const g = globalThis as unknown as { __sgNotifyBatch?: BatchState }
const batchState: BatchState = g.__sgNotifyBatch ?? (g.__sgNotifyBatch = { pending: [], timer: null })

export function queueEventNotifications(events: CompactEvent[]): void {
  if (events.length === 0) return
  batchState.pending.push(...events)
  if (batchState.timer) return
  batchState.timer = setTimeout(() => {
    const events2 = batchState.pending
    batchState.pending = []
    batchState.timer = null
    if (events2.length > 0) {
      void notify('event:new', { events: events2, count: events2.length, ts: new Date().toISOString() })
    }
  }, 400)
}

// ---- stats loop (every 5 s) ----
interface StatsLoopState {
  timer: ReturnType<typeof setInterval> | null
}
const gs = globalThis as unknown as { __sgStatsLoop?: StatsLoopState }
const statsLoop: StatsLoopState = gs.__sgStatsLoop ?? (gs.__sgStatsLoop = { timer: null })

export function ensureStatsLoop(): void {
  if (statsLoop.timer) return
  statsLoop.timer = setInterval(() => {
    // daily backup check rides on the stats tick (self-throttled to one
    // DB read / 5 min; the backup itself runs at most once per 24 h)
    maybeRunBackup()
    void (async () => {
      try {
        const since = new Date(Date.now() - 24 * 3600 * 1000)
        const [events24h, detections24h, incidentsOpen, rejected24h, processed24h, lastEvent] = await Promise.all([
          db.event.count({ where: { ingestTime: { gte: since } } }),
          db.detection.count({ where: { createdAt: { gte: since } } }),
          db.incident.count({ where: { status: { in: ['NEW', 'TRIAGED', 'INVESTIGATING'] } } }),
          db.validationFailure.count({ where: { ts: { gte: since } } }),
          db.event.count({ where: { status: 'PROCESSED', ingestTime: { gte: since } } }),
          db.event.findFirst({ orderBy: { eventTime: 'desc' }, select: { eventTime: true } }),
        ])
        await notify('stats', {
          events24h,
          detections24h,
          incidentsOpen,
          rejected24h,
          processed24h,
          lastEventAt: lastEvent?.eventTime.toISOString() ?? null,
          queueDepth: 0,
          ts: new Date().toISOString(),
        })
      } catch {
        // ignore — retry next tick
      }
    })()
  }, 5000)
}
