// StreamGuard — POST /api/simulator/reset (ADMIN)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { forbidden, jsonOk, unauthorized } from '@/lib/engine/http'
import { seedLightBaseline, wipeDynamicTables } from '@/lib/engine/reset'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN')) return forbidden()

  await wipeDynamicTables()
  const baseline = await seedLightBaseline()
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'demo.reset',
    targetType: 'simulator',
    details: { reseededEvents: baseline.events },
  })
  return jsonOk({ ok: true, reseededEvents: baseline.events, chunks: baseline.chunks, note: 'Dynamic data wiped; users, rules and settings kept; incident ids continue (never reused).' })
}
