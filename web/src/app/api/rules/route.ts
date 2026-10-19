// StreamGuard — GET /api/rules (all roles; includes fireCount24h + lastFiredAt)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { apiRoute, jsonOk, unauthorized } from '@/lib/engine/http'
import { parseRuleRow } from '@/lib/engine/rules'
import type { Category, RuleSelector, Severity } from '@/lib/types'

function typedSelector(selector: {
  category?: string
  severity?: string[]
  sourceIdPrefix?: string
  sourceTypes?: string[]
  attribute?: { key: string; value: string }
}): RuleSelector {
  return {
    ...(selector.category ? { category: selector.category as Category } : {}),
    ...(selector.severity ? { severity: selector.severity as Severity[] } : {}),
    ...(selector.sourceIdPrefix ? { sourceIdPrefix: selector.sourceIdPrefix } : {}),
    ...(selector.attribute ? { attribute: selector.attribute } : {}),
  }
}

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()

  const since = new Date(Date.now() - 24 * 3600 * 1000)
  const rows = await db.rule.findMany({ orderBy: { id: 'asc' } })
  const [fired, lastFired] = await Promise.all([
    db.detection.groupBy({
      by: ['ruleId'],
      where: { status: 'ACTIVE', createdAt: { gte: since } },
      _count: { _all: true },
    }),
    // single groupBy instead of one findFirst per rule (N+1)
    db.detection.groupBy({
      by: ['ruleId'],
      where: { status: 'ACTIVE' },
      _max: { createdAt: true },
    }),
  ])
  const lastFiredAtByRule = new Map(lastFired.map((r) => [r.ruleId, r._max.createdAt]))

  const data = rows.map((row) => {
    const def = parseRuleRow(row)
    const last = lastFiredAtByRule.get(def.id)
    return {
        id: def.id,
        name: def.name,
        description: row.description,
        enabled: def.enabled,
        selector: typedSelector(def.selector),
        conditionType: def.conditionType,
        threshold: def.threshold,
        windowSeconds: def.windowSeconds,
        severity: def.severity as Severity,
        cooldownSeconds: def.cooldownSeconds,
        suppression: def.suppression,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
        fireCount24h: fired.find((f) => f.ruleId === def.id)?._count._all ?? 0,
        lastFiredAt: last?.toISOString() ?? null,
      }
    },
  )
  return jsonOk({ data, page: 1, pageSize: data.length, total: data.length })
})
