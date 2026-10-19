// StreamGuard — GET /api/events (filters validated; invalid -> 400 INVALID_FILTER)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit, requireSession } from '@/lib/auth'
import { CATEGORIES, SEVERITIES, SOURCE_TYPES } from '@/lib/types'
import { apiRoute, invalidFilter, jsonError, jsonOk, parsePagination, readEnumMulti, readEnumSingle, readIsoRange, readSafeString, unauthorized } from '@/lib/engine/http'
import { readExportParams, exportResponse, type ExportColumn } from '@/lib/engine/export'
import { serializeEvent } from '@/lib/engine/serialize'
import type { Prisma } from '@prisma/client'

const SOURCE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/
const RULE_ID_RE = /^SG-RULE-\d{3}$/
const INC_ID_RE = /^INC-\d{1,6}$/
const STATUSES = ['VALIDATED', 'REJECTED', 'PROCESSED'] as const
const ORIGINS = ['synthetic', 'external'] as const

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const url = new URL(req.url)

  const page = parsePagination(url)
  if (!page.ok) return invalidFilter(page.param)

  const severity = readEnumMulti(url, 'severity', SEVERITIES)
  if (severity.error) return invalidFilter('severity', severity.error)
  const category = readEnumSingle(url, 'category', CATEGORIES)
  if (category.error) return invalidFilter('category', category.error)
  const sourceType = readEnumSingle(url, 'sourceType', SOURCE_TYPES)
  if (sourceType.error) return invalidFilter('sourceType', sourceType.error)
  const status = readEnumSingle(url, 'status', STATUSES)
  if (status.error) return invalidFilter('status', status.error)
  const origin = readEnumSingle(url, 'origin', ORIGINS)
  if (origin.error) return invalidFilter('origin', origin.error)
  const range = readIsoRange(url)
  if (range.error) return invalidFilter(range.error.includes('from') ? 'from' : 'to', range.error)

  const qRaw = url.searchParams.get('q')
  if (qRaw !== null && qRaw.trim().length < 2) return invalidFilter('q', 'q must be at least 2 characters')
  // strip SQL LIKE wildcards so q=%%% cannot match the whole table
  const q = qRaw !== null ? qRaw.replace(/[%_]/g, ' ') : null

  const sourceId = readSafeString(url, 'sourceId', 64)
  if (sourceId.error) return invalidFilter('sourceId', sourceId.error)
  if (sourceId.value && !SOURCE_ID_RE.test(sourceId.value)) return invalidFilter('sourceId', 'sourceId must match [a-zA-Z0-9._-]{1,64}')

  const correlationId = readSafeString(url, 'correlationId', 128)
  if (correlationId.error) return invalidFilter('correlationId', correlationId.error)
  const traceId = readSafeString(url, 'traceId', 128)
  if (traceId.error) return invalidFilter('traceId', traceId.error)

  const ruleId = readSafeString(url, 'ruleId', 32)
  if (ruleId.error) return invalidFilter('ruleId', ruleId.error)
  if (ruleId.value && !RULE_ID_RE.test(ruleId.value)) return invalidFilter('ruleId', 'ruleId must match SG-RULE-###')

  const incidentId = readSafeString(url, 'incidentId', 16)
  if (incidentId.error) return invalidFilter('incidentId', incidentId.error)
  if (incidentId.value && !INC_ID_RE.test(incidentId.value)) return invalidFilter('incidentId', 'incidentId must match INC-######')

  // ruleId/incidentId filters map through incident-linked events
  let linkedEventIds: string[] | null = null
  if (ruleId.value || incidentId.value) {
    const incidents = await db.incident.findMany({
      where: {
        ...(ruleId.value ? { ruleId: ruleId.value } : {}),
        ...(incidentId.value ? { id: incidentId.value } : {}),
      },
      select: { id: true },
      take: 200,
    })
    if (incidents.length === 0) {
      return jsonOk({ data: [], page: page.value.page, pageSize: page.value.pageSize, total: 0 })
    }
    const links = await db.incidentEvent.findMany({
      where: { incidentId: { in: incidents.map((i) => i.id) } },
      select: { eventId: true },
      take: 10000,
    })
    linkedEventIds = Array.from(new Set(links.map((l) => l.eventId)))
    if (linkedEventIds.length === 0) {
      return jsonOk({ data: [], page: page.value.page, pageSize: page.value.pageSize, total: 0 })
    }
  }

  const where: Prisma.EventWhereInput = {
    ...(severity.values ? { severity: { in: severity.values } } : {}),
    ...(category.value ? { category: category.value } : {}),
    ...(sourceType.value ? { sourceType: sourceType.value } : {}),
    ...(status.value ? { status: status.value } : {}),
    ...(origin.value ? { origin: origin.value } : {}),
    ...(sourceId.value ? { sourceId: sourceId.value } : {}),
    ...(correlationId.value ? { correlationId: correlationId.value } : {}),
    ...(traceId.value ? { traceId: traceId.value } : {}),
    ...(range.from || range.to
      ? { eventTime: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {}),
    ...(linkedEventIds ? { id: { in: linkedEventIds } } : {}),
    ...(q
      ? {
          OR: [
            { message: { contains: q } },
            { actor: { contains: q } },
          ],
        }
      : {}),
  }

  // evidence export branch (format=csv|json + limit ≤ 5000; audited)
  const exp = readExportParams(url)
  if (!exp.ok) return exp.error
  if (exp.value) return exportEvents(session, where, exp.value)

  const [total, rows] = await Promise.all([
    db.event.count({ where }),
    db.event.findMany({
      where,
      orderBy: { eventTime: 'desc' },
      skip: page.value.skip,
      take: page.value.take,
    }),
  ])
  return jsonOk({ data: rows.map(serializeEvent), page: page.value.page, pageSize: page.value.pageSize, total })
})

const EVENT_EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'id', key: 'id' },
  { header: 'eventTime', key: 'eventTime' },
  { header: 'ingestTime', key: 'ingestTime' },
  { header: 'sourceId', key: 'sourceId' },
  { header: 'sourceType', key: 'sourceType' },
  { header: 'severity', key: 'severity' },
  { header: 'category', key: 'category' },
  { header: 'status', key: 'status' },
  { header: 'origin', key: 'origin' },
  { header: 'actor', key: 'actor' },
  { header: 'correlationId', key: 'correlationId' },
  { header: 'traceId', key: 'traceId' },
  { header: 'latencyMs', key: 'latencyMs' },
  { header: 'message', key: 'message' },
  { header: 'attributes', key: 'attributes' },
  { header: 'rejectionReason', key: 'rejectionReason' },
]

/** Shared export branch for the events list (format=csv|json + limit, ≤5000 rows). */
async function exportEvents(
  session: { user: { username: string; role: string } },
  where: Prisma.EventWhereInput,
  params: { format: 'csv' | 'json'; limit: number },
): Promise<NextResponse> {
  const rows = await db.event.findMany({ where, orderBy: { eventTime: 'desc' }, take: params.limit })
  const data = rows.map(serializeEvent) as unknown as Array<Record<string, unknown>>
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'export',
    targetType: 'export',
    targetId: 'events',
    details: { format: params.format, count: data.length, limit: params.limit },
  })
  return exportResponse('events', params, data, EVENT_EXPORT_COLUMNS)
}

export const POST = apiRoute(async (): Promise<NextResponse> => {
  return jsonError(405, 'METHOD_NOT_ALLOWED', 'Use GET /api/events')
})
