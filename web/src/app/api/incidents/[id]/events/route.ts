// StreamGuard — GET /api/incidents/[id]/events (paginated incident events)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { apiRoute, invalidFilter, jsonOk, notFound, parsePagination, unauthorized } from '@/lib/engine/http'
import { serializeEvent } from '@/lib/engine/serialize'

const INC_ID_RE = /^INC-\d{1,6}$/

export const GET = apiRoute<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const { id } = await params
  if (!INC_ID_RE.test(id)) return notFound('incident')
  const url = new URL(req.url)
  const page = parsePagination(url)
  if (!page.ok) return invalidFilter(page.param)

  const incident = await db.incident.findUnique({ where: { id }, select: { id: true } })
  if (!incident) return notFound('incident')

  const [total, links] = await Promise.all([
    db.incidentEvent.count({ where: { incidentId: id } }),
    db.incidentEvent.findMany({ where: { incidentId: id }, orderBy: { addedAt: 'asc' }, take: 10000 }),
  ])
  // sort by event time, then paginate in memory over a bounded set
  const rows = links.length > 0 ? await db.event.findMany({ where: { id: { in: links.map((l) => l.eventId) } } }) : []
  const lateMap = new Map(links.map((l) => [l.eventId, l.late]))
  const sorted = rows.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
  const slice = sorted.slice(page.value.skip, page.value.skip + page.value.take)

  return jsonOk({
    data: slice.map((r) => ({ ...serializeEvent(r), late: lateMap.get(r.id) ?? false })),
    page: page.value.page,
    pageSize: page.value.pageSize,
    total,
  })
})
