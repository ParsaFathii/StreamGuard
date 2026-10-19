// StreamGuard — GET /api/simulator/scenarios (ANALYST+)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { requireRole, requireSession } from '@/lib/auth'
import { apiRoute, forbidden, jsonOk, unauthorized } from '@/lib/engine/http'
import { SCENARIOS } from '@/lib/engine/simulator'
import type { Severity } from '@/lib/types'

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN', 'ANALYST')) return forbidden()
  return jsonOk(
    SCENARIOS.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      expectedDetections: s.expectedDetections,
      expectedIncidentSeverity: s.expectedIncidentSeverity as Severity | null,
    })),
  )
})
