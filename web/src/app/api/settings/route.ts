// StreamGuard — GET/PATCH /api/settings
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { DEFAULT_SETTINGS, getSettings, invalidateSettingsCache } from '@/lib/settings'
import { forbidden, jsonError, jsonOk, unauthorized } from '@/lib/engine/http'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const s = await getSettings()
  // no secrets are stored in app settings at all (shape is public below)
  return jsonOk({ ...s })
}

const PatchBody = z
  .object({
    aiEnabled: z.boolean().optional(),
    aiProvider: z.string().min(1).max(32).optional(),
    correlationWindowSeconds: z.number().int().min(60).max(3600).optional(),
    retentionHours: z.number().int().min(1).max(720).optional(),
    maxBatchSize: z.number().int().min(1).max(100).optional(),
    rateLimitPerMin: z.number().int().min(1).max(1000).optional(),
    languageDefault: z.enum(['en', 'fa']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' })

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN')) return forbidden()

  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
  }
  const body = PatchBody.safeParse(parsed)
  if (!body.success) {
    return jsonError(400, 'INVALID_BODY', body.error.issues[0]?.message ?? 'invalid settings patch')
  }
  const current = await getSettings()
  const merged = { ...current, ...body.data }
  await db.setting.upsert({
    where: { key: 'app' },
    create: { key: 'app', value: JSON.stringify(merged) },
    update: { value: JSON.stringify(merged) },
  })
  invalidateSettingsCache()
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of Object.keys(body.data) as Array<keyof typeof body.data>) {
    const prev = current[k as keyof typeof current]
    if (prev !== body.data[k]) changes[k] = { from: prev, to: body.data[k] }
  }
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'settings.update',
    targetType: 'settings',
    details: changes,
  })
  return jsonOk({ ...merged, defaults: DEFAULT_SETTINGS })
}
