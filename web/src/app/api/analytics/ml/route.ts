// StreamGuard — GET /api/analytics/ml
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { requireSession } from '@/lib/auth'
import { apiRoute, jsonOk, unauthorized } from '@/lib/engine/http'
import { computeMlViewCached, getLatestEvaluation } from '@/lib/engine/ml'

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const [view, lastEvaluation] = await Promise.all([computeMlViewCached(120), getLatestEvaluation()])
  return jsonOk({ ...view, lastEvaluation })
})
