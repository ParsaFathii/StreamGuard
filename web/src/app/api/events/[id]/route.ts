// StreamGuard — GET /api/events/[id]
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { apiRoute, jsonError, jsonOk, notFound, unauthorized } from '@/lib/engine/http'
import { serializeEvent } from '@/lib/engine/serialize'

export const GET = apiRoute<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const { id } = await params
  if (id.length > 128) return jsonError(400, 'INVALID_PARAM', 'event id too long')
  const row = await db.event.findUnique({ where: { id } })
  if (!row) return notFound('event')
  return jsonOk(serializeEvent(row))
})
