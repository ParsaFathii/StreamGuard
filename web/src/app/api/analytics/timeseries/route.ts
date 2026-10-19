// StreamGuard — GET /api/analytics/timeseries
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { apiRoute, invalidFilter, jsonOk, unauthorized } from '@/lib/engine/http'

const METRICS = ['events', 'detections', 'rejected'] as const

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const url = new URL(req.url)

  const metric = url.searchParams.get('metric') ?? 'events'
  if (!METRICS.includes(metric as (typeof METRICS)[number])) {
    return invalidFilter('metric', `metric must be one of ${METRICS.join('|')}`)
  }
  const bucket = url.searchParams.get('bucket') ?? 'minute'
  if (bucket !== 'minute') return invalidFilter('bucket', "bucket must be 'minute'")

  let points = 60
  const rawPoints = url.searchParams.get('points')
  if (rawPoints !== null) {
    const n = Number(rawPoints)
    if (!Number.isInteger(n) || n < 10 || n > 240) return invalidFilter('points', 'points must be an integer 10..240')
    points = n
  }

  const since = new Date(Date.now() - points * 60_000)
  const firstMinute = Math.floor(since.getTime() / 60_000) * 60_000

  const perMinute = new Map<number, number>()
  const bump = (ts: number) => {
    const m = Math.floor(ts / 60_000) * 60_000
    perMinute.set(m, (perMinute.get(m) ?? 0) + 1)
  }

  if (metric === 'events') {
    const rows = await db.event.findMany({ where: { eventTime: { gte: new Date(firstMinute) } }, select: { eventTime: true }, take: 20000 })
    for (const r of rows) bump(r.eventTime.getTime())
  } else if (metric === 'detections') {
    const rows = await db.detection.findMany({ where: { createdAt: { gte: new Date(firstMinute) } }, select: { createdAt: true }, take: 20000 })
    for (const r of rows) bump(r.createdAt.getTime())
  } else {
    const rows = await db.validationFailure.findMany({ where: { ts: { gte: new Date(firstMinute) } }, select: { ts: true }, take: 20000 })
    for (const r of rows) bump(r.ts.getTime())
  }

  const data: Array<{ bucketStart: string; value: number }> = []
  for (let i = 0; i < points; i++) {
    const m = firstMinute + i * 60_000
    data.push({ bucketStart: new Date(m).toISOString(), value: perMinute.get(m) ?? 0 })
  }
  return jsonOk(data)
})
