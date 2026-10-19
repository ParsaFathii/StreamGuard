// StreamGuard — GET /api/analytics/overview
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { getSettings } from '@/lib/settings'
import { apiRoute, jsonOk, unauthorized } from '@/lib/engine/http'
import { procStats } from '@/lib/engine/proc-stats'
import { SEVERITIES, type Severity } from '@/lib/types'

async function wsUp(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:3003/health', { signal: AbortSignal.timeout(700) })
    return res.ok
  } catch {
    return false
  }
}

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()

  const now = Date.now()
  const since24h = new Date(now - 24 * 3600 * 1000)
  const since7d = new Date(now - 7 * 24 * 3600 * 1000)
  const since60m = new Date(now - 60 * 60 * 1000)

  const settings = await getSettings()
  const [
    events24h, events7d, detections24h, incidentsOpen, incidents24h, rejected24h,
    severityRows, categoryRows, topSourceRows, latencyRows, lastProcessed, wsOk,
  ] = await Promise.all([
    db.event.count({ where: { eventTime: { gte: since24h } } }),
    db.event.count({ where: { eventTime: { gte: since7d } } }),
    db.detection.count({ where: { createdAt: { gte: since24h } } }),
    db.incident.count({ where: { status: { in: ['NEW', 'TRIAGED', 'INVESTIGATING'] } } }),
    db.incident.count({ where: { createdAt: { gte: since24h } } }),
    db.validationFailure.count({ where: { ts: { gte: since24h } } }),
    db.event.groupBy({ by: ['severity'], where: { eventTime: { gte: since24h } }, _count: { _all: true } }),
    db.event.groupBy({ by: ['category'], where: { eventTime: { gte: since24h } }, _count: { _all: true } }),
    db.event.groupBy({ by: ['sourceId'], where: { eventTime: { gte: since24h } }, _count: { _all: true } }),
    db.event.findMany({ where: { ingestTime: { gte: since24h }, latencyMs: { not: null } }, select: { latencyMs: true }, take: 5000 }),
    // all stored events are PROCESSED (rejected ones never reach the Event
    // table) — dropping the status filter lets the top-1 use the ingestTime index
    db.event.findFirst({ orderBy: { ingestTime: 'desc' }, select: { ingestTime: true } }),
    wsUp(),
  ])

  // ingest rate per minute (last 60 min, by ingestTime)
  const ingestRows = await db.event.findMany({
    where: { ingestTime: { gte: since60m } },
    select: { ingestTime: true },
    take: 20000,
  })
  const perMinute = new Map<number, number>()
  for (const r of ingestRows) {
    const m = Math.floor(r.ingestTime.getTime() / 60_000) * 60_000
    perMinute.set(m, (perMinute.get(m) ?? 0) + 1)
  }
  const firstMinute = Math.floor(since60m.getTime() / 60_000) * 60_000
  const ingestRatePerMin: Array<{ minute: string; count: number }> = []
  for (let i = 0; i < 60; i++) {
    const m = firstMinute + i * 60_000
    ingestRatePerMin.push({ minute: new Date(m).toISOString(), count: perMinute.get(m) ?? 0 })
  }

  const severityBreakdown: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 }
  for (const s of SEVERITIES) severityBreakdown[s] = severityRows.find((r) => r.severity === s)?._count._all ?? 0
  const categoryBreakdown: Record<string, number> = {}
  for (const r of categoryRows) categoryBreakdown[r.category] = r._count._all
  const topSources = topSourceRows
    .map((r) => ({ sourceId: r.sourceId, count: r._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  const latencies = latencyRows.map((r) => r.latencyMs ?? 0)
  const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
  const p95 = (() => {
    if (latencies.length === 0) return 0
    const sorted = [...latencies].sort((a, b) => a - b)
    return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]
  })()

  return jsonOk({
    totals: {
      events24h,
      events7d,
      detections24h,
      incidentsOpen,
      incidents24h,
      rejected24h,
      duplicates24h: procStats.ingestDuplicates, // process-local (documented)
    },
    ingestRatePerMin,
    severityBreakdown24h: severityBreakdown,
    categoryBreakdown24h: categoryBreakdown,
    topSources24h: topSources,
    processing: {
      avgLatencyMs24h: avg,
      p95LatencyMs24h: p95,
      lastProcessedAt: lastProcessed?.ingestTime.toISOString() ?? null,
    },
    health: {
      db: 'up' as const,
      ws: wsOk ? ('up' as const) : ('down' as const),
      llm: settings.aiEnabled ? ('ok' as const) : ('disabled' as const),
      queueDepth: 0,
    },
  })
})
