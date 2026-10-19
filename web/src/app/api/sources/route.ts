// StreamGuard — GET /api/sources (derived from real event data — no fake entries)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { jsonOk, unauthorized } from '@/lib/engine/http'
import { SOURCE_REGISTRY } from '@/lib/engine/simulator'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()

  const since24h = new Date(Date.now() - 24 * 3600 * 1000)
  const since15m = new Date(Date.now() - 15 * 60_000)
  const since10m = new Date(Date.now() - 10 * 60_000)

  const [recent, lastEventRows, vfRows] = await Promise.all([
    db.event.groupBy({ by: ['sourceId', 'sourceType', 'origin'], where: { eventTime: { gte: since24h } }, _count: { _all: true } }),
    db.event.groupBy({ by: ['sourceId'], _max: { eventTime: true } }),
    db.validationFailure.groupBy({ by: ['sourceId'], where: { ts: { gte: since15m } }, _count: { _all: true } }),
  ])
  const lastEventAt = new Map(lastEventRows.map((r) => [r.sourceId, r._max.eventTime]))
  const vfBySource = new Map(vfRows.filter((r) => r.sourceId).map((r) => [r.sourceId as string, r._count._all]))
  const counts = new Map(recent.map((r) => [r.sourceId, r._count._all]))

  // per-source type/origin taken from the actual event rows (majority count wins)
  const typeBySource = new Map<string, string>()
  const originBySource = new Map<string, string>()
  const typeCount = new Map<string, number>()
  const originCount = new Map<string, number>()
  for (const r of recent) {
    const tc = typeCount.get(r.sourceId) ?? -1
    if (r._count._all > tc) {
      typeBySource.set(r.sourceId, r.sourceType)
      typeCount.set(r.sourceId, r._count._all)
    }
    const oc = originCount.get(r.sourceId) ?? -1
    if (r._count._all > oc) {
      originBySource.set(r.sourceId, r.origin)
      originCount.set(r.sourceId, r._count._all)
    }
  }

  const ids = new Set<string>([...counts.keys(), ...lastEventAt.keys()])
  const data = [...ids].sort()
    .map((id) => {
      const known = SOURCE_REGISTRY[id]
      const origin = (originBySource.get(id) ?? 'synthetic') as 'synthetic' | 'external'
      const last = lastEventAt.get(id) ?? null
      const rejections = vfBySource.get(id) ?? 0
      const status: 'active' | 'idle' | 'error' = rejections >= 5 ? 'error' : last && last >= since10m ? 'active' : 'idle'
      return {
        id,
        name: known?.name ?? id,
        type: typeBySource.get(id) ?? known?.type ?? 'app',
        origin,
        events24h: counts.get(id) ?? 0,
        lastEventAt: last ? last.toISOString() : null,
        status,
        description:
          known?.description ??
          (origin === 'external'
            ? `External event source ${id} (seen in ingest traffic)`
            : `Simulator source ${id} (seen in ingest traffic)`),
      }
    })
  return jsonOk(data)
}
