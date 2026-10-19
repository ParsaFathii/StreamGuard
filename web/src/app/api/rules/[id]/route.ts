// StreamGuard — PATCH /api/rules/[id] (ANALYST+; VIEWER -> 403)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { forbidden, jsonError, jsonOk, notFound, unauthorized } from '@/lib/engine/http'
import { SEVERITIES } from '@/lib/types'

const Body = z
  .object({
    enabled: z.boolean().optional(),
    threshold: z.number().min(1).max(10000).optional(),
    windowSeconds: z.number().int().min(10).max(3600).optional(),
    severity: z.enum(SEVERITIES).optional(),
    cooldownSeconds: z.number().int().min(0).max(3600).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' })

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN', 'ANALYST')) return forbidden()
  const { id } = await params
  if (!/^SG-RULE-\d{3}$/.test(id)) return jsonError(400, 'INVALID_PARAM', 'rule id must match SG-RULE-###')

  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
  }
  const body = Body.safeParse(parsed)
  if (!body.success) {
    return jsonError(400, 'INVALID_BODY', body.error.issues[0]?.message ?? 'invalid rule patch')
  }

  const existing = await db.rule.findUnique({ where: { id } })
  if (!existing) return notFound('rule')

  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const data: Record<string, unknown> = {}
  if (body.data.enabled !== undefined && body.data.enabled !== existing.enabled) {
    changes.enabled = { from: existing.enabled, to: body.data.enabled }
    data.enabled = body.data.enabled
  }
  if (body.data.threshold !== undefined && body.data.threshold !== existing.threshold) {
    changes.threshold = { from: existing.threshold, to: body.data.threshold }
    data.threshold = body.data.threshold
  }
  if (body.data.windowSeconds !== undefined && body.data.windowSeconds !== existing.windowSeconds) {
    changes.windowSeconds = { from: existing.windowSeconds, to: body.data.windowSeconds }
    data.windowSeconds = body.data.windowSeconds
  }
  if (body.data.severity !== undefined && body.data.severity !== existing.severity) {
    changes.severity = { from: existing.severity, to: body.data.severity }
    data.severity = body.data.severity
  }
  if (body.data.cooldownSeconds !== undefined && body.data.cooldownSeconds !== existing.cooldownSeconds) {
    changes.cooldownSeconds = { from: existing.cooldownSeconds, to: body.data.cooldownSeconds }
    data.cooldownSeconds = body.data.cooldownSeconds
  }
  if (Object.keys(data).length === 0) {
    return jsonOk({ id: existing.id, version: existing.version, updatedAt: existing.updatedAt.toISOString(), unchanged: true })
  }

  const updated = await db.rule.update({
    where: { id },
    data: { ...data, version: { increment: 1 } },
  })
  const changesJson = JSON.stringify(changes)
  await db.ruleAudit.create({
    data: {
      ruleId: id,
      actor: session.user.username,
      action: 'updated',
      changes: changesJson,
    },
  })
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'rule.update',
    targetType: 'rule',
    targetId: id,
    details: changes,
  })
  return jsonOk({
    id: updated.id,
    enabled: updated.enabled,
    threshold: updated.threshold,
    windowSeconds: updated.windowSeconds,
    severity: updated.severity,
    cooldownSeconds: updated.cooldownSeconds,
    version: updated.version,
    updatedAt: updated.updatedAt.toISOString(),
  })
}
