// StreamGuard — GET /api/audit (ADMIN)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireRole, requireSession } from '@/lib/auth'
import { apiRoute, forbidden, invalidFilter, jsonOk, parsePagination, readEnumSingle, readIsoRange, readSafeString, unauthorized } from '@/lib/engine/http'
import type { Prisma } from '@prisma/client'

// closed sets written by this backend (filters are validated against them)
export const AUDIT_ACTIONS = [
  'login',
  'logout',
  'rule.update',
  'incident.update',
  'incident.note',
  'ai.investigate',
  'simulator.run',
  'settings.update',
  'demo.reset',
  'retention.run',
  'ingest',
] as const
const AUDIT_TARGET_TYPES = ['rule', 'incident', 'session', 'settings', 'simulator', 'ingest', 'retention', 'user'] as const

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN')) return forbidden()
  const url = new URL(req.url)

  const page = parsePagination(url, 25, 100)
  if (!page.ok) return invalidFilter(page.param)
  const actor = readSafeString(url, 'actor', 64)
  if (actor.error) return invalidFilter('actor', actor.error)
  const action = readEnumSingle(url, 'action', AUDIT_ACTIONS)
  if (action.error) return invalidFilter('action', action.error)
  const targetType = readEnumSingle(url, 'targetType', AUDIT_TARGET_TYPES)
  if (targetType.error) return invalidFilter('targetType', targetType.error)
  const range = readIsoRange(url)
  if (range.error) return invalidFilter(range.error.includes('from') ? 'from' : 'to', range.error)

  const where: Prisma.AuditLogWhereInput = {
    ...(actor.value ? { actor: actor.value } : {}),
    ...(action.value ? { action: action.value } : {}),
    ...(targetType.value ? { targetType: targetType.value } : {}),
    ...(range.from || range.to
      ? { ts: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {}),
  }
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({ where, orderBy: { ts: 'desc' }, skip: page.value.skip, take: page.value.take }),
  ])
  return jsonOk({
    data: rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      actor: r.actor,
      role: r.role,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      details: JSON.parse(r.details) as Record<string, unknown>,
    })),
    page: page.value.page,
    pageSize: page.value.pageSize,
    total,
  })
})
