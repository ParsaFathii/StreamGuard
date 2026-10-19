// StreamGuard — GET /api/rules/[id]/audit (ADMIN only)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireRole, requireSession } from '@/lib/auth'
import { apiRoute, forbidden, invalidFilter, jsonOk, notFound, parsePagination, unauthorized } from '@/lib/engine/http'

export const GET = apiRoute<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN')) return forbidden()
  const { id } = await params
  if (!/^SG-RULE-\d{3}$/.test(id)) return notFound('rule')
  const url = new URL(req.url)
  const page = parsePagination(url)
  if (!page.ok) return invalidFilter(page.param)

  const [total, rows] = await Promise.all([
    db.ruleAudit.count({ where: { ruleId: id } }),
    db.ruleAudit.findMany({ where: { ruleId: id }, orderBy: { ts: 'desc' }, skip: page.value.skip, take: page.value.take }),
  ])
  return jsonOk({
    data: rows.map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      actor: r.actor,
      action: r.action,
      changes: JSON.parse(r.changes) as Record<string, unknown>,
      ts: r.ts.toISOString(),
    })),
    page: page.value.page,
    pageSize: page.value.pageSize,
    total,
  })
})
