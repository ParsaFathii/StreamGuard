// StreamGuard — POST /api/simulator/tick {count? 1..50, default 12} (ANALYST+)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { forbidden, jsonError, jsonOk, unauthorized } from '@/lib/engine/http'
import { generateTick, mulberry32 } from '@/lib/engine/simulator'
import { ingestEvents } from '@/lib/engine/pipeline'

const Body = z.object({ count: z.number().int().min(1).max(50).optional() })

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN', 'ANALYST')) return forbidden()

  let count = 12
  const raw = await req.text()
  if (raw.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
    }
    const body = Body.safeParse(parsed)
    if (!body.success) return jsonError(400, 'INVALID_BODY', 'count must be an integer 1..50')
    if (body.data.count !== undefined) count = body.data.count
  }

  const rng = mulberry32(Date.now() % 2147483647) // per-tick variety; tick is ambient noise, not a labeled scenario
  const raws = generateTick(rng, new Date(), count)
  const result = await ingestEvents(raws, { origin: 'synthetic' })
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'simulator.run',
    targetType: 'simulator',
    targetId: 'tick',
    details: { generated: raws.length, accepted: result.accepted },
  })
  return jsonOk({ generated: raws.length, eventIds: result.eventIds, accepted: result.accepted, duplicates: result.duplicates, rejected: result.rejected })
}
