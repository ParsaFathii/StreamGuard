// StreamGuard — POST /api/incidents/[id]/notes (ANALYST+)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { forbidden, jsonError, jsonOk, notFound, unauthorized } from '@/lib/engine/http'

const INC_ID_RE = /^INC-\d{1,6}$/
const Body = z.object({ body: z.string().min(1).max(4000) })

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN', 'ANALYST')) return forbidden()
  const { id } = await params
  if (!INC_ID_RE.test(id)) return notFound('incident')

  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
  }
  const body = Body.safeParse(parsed)
  if (!body.success) {
    return jsonError(400, 'INVALID_BODY', 'body is required (1..4000 chars)')
  }
  const incident = await db.incident.findUnique({ where: { id }, select: { id: true } })
  if (!incident) return notFound('incident')

  const note = await db.incidentNote.create({
    data: { incidentId: id, author: session.user.username, body: body.data.body },
  })
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'incident.note',
    targetType: 'incident',
    targetId: id,
    details: { noteId: note.id, length: body.data.body.length },
  })
  return jsonOk({ id: note.id, incidentId: id, author: note.author, body: note.body, createdAt: note.createdAt.toISOString() })
}
