// StreamGuard — GET /api/incidents (filters + sort)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { SEVERITIES } from '@/lib/types'
import {
  invalidFilter, jsonOk, parsePagination, readEnumMulti, readEnumSingle, readIsoRange, readSafeString, unauthorized,
} from '@/lib/engine/http'
import { serializeIncident } from '@/lib/engine/serialize'
import type { Prisma } from '@prisma/client'

const STATUSES = ['NEW', 'TRIAGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const
const SORTS = ['createdAt', 'severity', 'updatedAt'] as const
const RULE_ID_RE = /^SG-RULE-\d{3}$/
const INC_ID_RE = /^INC-\d{1,6}$/

export async function GET(req: NextRequest): Promise<NextResponse> {
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
  const orderBy: Prisma.IncidentOrderByWithRelationInput =
    sortKey === 'severity' ? { severity: 'desc' as const, updatedAt: 'desc' as const } : { [sortKey]: 'desc' as const }

  const [total, rows] = await Promise.all([
    db.incident.count({ where }),
    db.incident.findMany({ where, orderBy, skip: page.value.skip, take: page.value.take }),
  ])
  return jsonOk({ data: rows.map(serializeIncident), page: page.value.page, pageSize: page.value.pageSize, total })
}
