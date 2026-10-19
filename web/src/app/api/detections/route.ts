// StreamGuard — GET /api/detections
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit, requireSession } from '@/lib/auth'
import { SEVERITIES } from '@/lib/types'
import { apiRoute, invalidFilter, jsonOk, parsePagination, readEnumSingle, readIsoRange, readSafeString, unauthorized } from '@/lib/engine/http'
import { readExportParams, exportResponse, type ExportColumn } from '@/lib/engine/export'
import { serializeDetection } from '@/lib/engine/serialize'
import type { Prisma } from '@prisma/client'

const RULE_ID_RE = /^SG-RULE-\d{3}$/
const STATUSES = ['ACTIVE', 'SUPPRESSED'] as const

const DETECTION_EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'id', key: 'id' },
  { header: 'createdAt', key: 'createdAt' },
  { header: 'ruleId', key: 'ruleId' },
  { header: 'eventId', key: 'eventId' },
  { header: 'incidentId', key: 'incidentId' },
  { header: 'severity', key: 'severity' },
  { header: 'score', key: 'score' },
  { header: 'status', key: 'status' },
  { header: 'title', key: 'title' },
  { header: 'detail', key: 'detail' },
]

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const url = new URL(req.url)

  const page = parsePagination(url)
  if (!page.ok) return invalidFilter(page.param)

  const ruleId = readSafeString(url, 'ruleId', 32)
  if (ruleId.error) return invalidFilter('ruleId', ruleId.error)
  if (ruleId.value && !RULE_ID_RE.test(ruleId.value)) return invalidFilter('ruleId', 'ruleId must match SG-RULE-###')

  const severity = readEnumSingle(url, 'severity', SEVERITIES)
  if (severity.error) return invalidFilter('severity', severity.error)
  const status = readEnumSingle(url, 'status', STATUSES)
  if (status.error) return invalidFilter('status', status.error)
  const range = readIsoRange(url)
  if (range.error) return invalidFilter(range.error.includes('from') ? 'from' : 'to', range.error)

  const incidentId = readSafeString(url, 'incidentId', 16)
  if (incidentId.error) return invalidFilter('incidentId', incidentId.error)

  const where: Prisma.DetectionWhereInput = {
    ...(ruleId.value ? { ruleId: ruleId.value } : {}),
    ...(severity.value ? { severity: severity.value } : {}),
    ...(status.value ? { status: status.value } : {}),
    ...(incidentId.value ? { incidentId: incidentId.value } : {}),
    ...(range.from || range.to
      ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {}),
  }

  // evidence export branch (format=csv|json + limit ≤ 5000; audited)
  const exp = readExportParams(url)
  if (!exp.ok) return exp.error
  if (exp.value) {
    const rows = await db.detection.findMany({ where, orderBy: { createdAt: 'desc' }, take: exp.value.limit })
    const data = rows.map(serializeDetection) as unknown as Array<Record<string, unknown>>
    await audit({
      actor: session.user.username,
      role: session.user.role,
      action: 'export',
      targetType: 'export',
      targetId: 'detections',
      details: { format: exp.value.format, count: data.length, limit: exp.value.limit },
    })
    return exportResponse('detections', exp.value, data, DETECTION_EXPORT_COLUMNS)
  }
  const [total, rows] = await Promise.all([
    db.detection.count({ where }),
    db.detection.findMany({ where, orderBy: { createdAt: 'desc' }, skip: page.value.skip, take: page.value.take }),
  ])
  return jsonOk({ data: rows.map(serializeDetection), page: page.value.page, pageSize: page.value.pageSize, total })
})
