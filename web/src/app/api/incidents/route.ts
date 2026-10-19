// StreamGuard — GET /api/incidents (filters + sort)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit, requireSession } from '@/lib/auth'
import { SEVERITIES } from '@/lib/types'
import { apiRoute, invalidFilter, jsonOk, parsePagination, readEnumMulti, readEnumSingle, readIsoRange, readSafeString, unauthorized } from '@/lib/engine/http'
import { readExportParams, exportResponse, type ExportColumn } from '@/lib/engine/export'
import { serializeIncident } from '@/lib/engine/serialize'
import type { Prisma } from '@prisma/client'

const STATUSES = ['NEW', 'TRIAGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const
const SORTS = ['createdAt', 'severity', 'updatedAt'] as const
// severity rank order for sort=severity (lexical TEXT order would rank medium > low > info > high > critical)
const SEV_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }
const RULE_ID_RE = /^SG-RULE-\d{3}$/
const INC_ID_RE = /^INC-\d{1,6}$/

const INCIDENT_EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'id', key: 'id' },
  { header: 'title', key: 'title' },
  { header: 'severity', key: 'severity' },
  { header: 'status', key: 'status' },
  { header: 'ruleId', key: 'ruleId' },
  { header: 'correlationKey', key: 'correlationKey' },
  { header: 'correlationLabel', key: 'correlationLabel' },
  { header: 'eventCount', key: 'eventCount' },
  { header: 'detectionCount', key: 'detectionCount' },
  { header: 'firstEventTime', key: 'firstEventTime' },
  { header: 'lastEventTime', key: 'lastEventTime' },
  { header: 'assignedTo', key: 'assignedTo' },
  { header: 'resolutionSummary', key: 'resolutionSummary' },
  { header: 'createdAt', key: 'createdAt' },
  { header: 'updatedAt', key: 'updatedAt' },
]

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const url = new URL(req.url)

  const page = parsePagination(url)
  if (!page.ok) return invalidFilter(page.param)

  const status = readEnumMulti(url, 'status', STATUSES)
  if (status.error) return invalidFilter('status', status.error)
  const severity = readEnumMulti(url, 'severity', SEVERITIES)
  if (severity.error) return invalidFilter('severity', severity.error)
  const ruleId = readSafeString(url, 'ruleId', 32)
  if (ruleId.error) return invalidFilter('ruleId', ruleId.error)
  if (ruleId.value && !RULE_ID_RE.test(ruleId.value)) return invalidFilter('ruleId', 'ruleId must match SG-RULE-###')
  const incidentId = readSafeString(url, 'id', 16)
  if (incidentId.error) return invalidFilter('id', incidentId.error)
  if (incidentId.value && !INC_ID_RE.test(incidentId.value)) return invalidFilter('id', 'id must match INC-######')
  const assignedTo = readSafeString(url, 'assignedTo', 64)
  if (assignedTo.error) return invalidFilter('assignedTo', assignedTo.error)
  const range = readIsoRange(url)
  if (range.error) return invalidFilter(range.error.includes('from') ? 'from' : 'to', range.error)
  const sort = readEnumSingle(url, 'sort', SORTS)
  if (sort.error) return invalidFilter('sort', sort.error)
  const q = url.searchParams.get('q')
  if (q !== null && q.trim().length < 2) return invalidFilter('q', 'q must be at least 2 characters')

  const where: Prisma.IncidentWhereInput = {
    ...(status.values ? { status: { in: status.values } } : {}),
    ...(severity.values ? { severity: { in: severity.values } } : {}),
    ...(ruleId.value ? { ruleId: ruleId.value } : {}),
    ...(incidentId.value ? { id: incidentId.value } : {}),
    ...(assignedTo.value ? { assignedTo: assignedTo.value } : {}),
    ...(range.from || range.to
      ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {}),
    ...(q ? { title: { contains: q } } : {}),
  }

  const sortKey = sort.value ?? 'createdAt'
  const orderBy: Prisma.IncidentOrderByWithRelationInput[] =
    sortKey === 'severity' ? [{ severity: 'desc' as const }, { updatedAt: 'desc' as const }] : [{ [sortKey]: 'desc' as const }]

  // evidence export branch (format=csv|json + limit ≤ 5000; audited; honors sort=severity rank order)
  const exp = readExportParams(url)
  if (!exp.ok) return exp.error
  if (exp.value) {
    let rowsRaw
    if (sortKey === 'severity') {
      const all = await db.incident.findMany({ where, orderBy: { updatedAt: 'desc' } })
      all.sort(
        (a, b) => (SEV_RANK[b.severity] ?? -1) - (SEV_RANK[a.severity] ?? -1)
          || b.updatedAt.getTime() - a.updatedAt.getTime(),
      )
      rowsRaw = all.slice(0, exp.value.limit)
    } else {
      rowsRaw = await db.incident.findMany({ where, orderBy, take: exp.value.limit })
    }
    const data = rowsRaw.map(serializeIncident) as unknown as Array<Record<string, unknown>>
    await audit({
      actor: session.user.username,
      role: session.user.role,
      action: 'export',
      targetType: 'export',
      targetId: 'incidents',
      details: { format: exp.value.format, count: data.length, limit: exp.value.limit, sort: sortKey },
    })
    return exportResponse('incidents', exp.value, data, INCIDENT_EXPORT_COLUMNS)
  }

  if (sortKey === 'severity') {
    // rank-order in memory (SQLite TEXT order is lexical: medium > low > info > high > critical).
    // Demo scale (<= hundreds of incidents) — full fetch + in-memory sort + manual slice is fine.
    const all = await db.incident.findMany({ where, orderBy: { updatedAt: 'desc' } })
    all.sort(
      (a, b) => (SEV_RANK[b.severity] ?? -1) - (SEV_RANK[a.severity] ?? -1)
        || b.updatedAt.getTime() - a.updatedAt.getTime(),
    )
    const rows = all.slice(page.value.skip, page.value.skip + page.value.take)
    return jsonOk({ data: rows.map(serializeIncident), page: page.value.page, pageSize: page.value.pageSize, total: all.length })
  }

  const [total, rows] = await Promise.all([
    db.incident.count({ where }),
    db.incident.findMany({ where, orderBy, skip: page.value.skip, take: page.value.take }),
  ])
  return jsonOk({ data: rows.map(serializeIncident), page: page.value.page, pageSize: page.value.pageSize, total })
})
