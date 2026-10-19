// StreamGuard — GET /api/analytics/ml
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { requireSession } from '@/lib/auth'
import { jsonOk, unauthorized } from '@/lib/engine/http'
import { computeMlView, getLatestEvaluation } from '@/lib/engine/ml'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const [view, lastEvaluation] = await Promise.all([computeMlView(120), getLatestEvaluation()])
  return jsonOk({ ...view, lastEvaluation })
}
