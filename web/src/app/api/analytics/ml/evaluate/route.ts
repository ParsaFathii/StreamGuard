// StreamGuard — POST /api/analytics/ml/evaluate (ANALYST+)
// Copyright © 2026 Parsa Fathi — Apache-2.0
// Deterministic labeled evaluation (fixed seed): rules-only vs zscore vs
// iforest on a simulator-generated ground-truth dataset. Real computed metrics.
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireRole, requireSession } from '@/lib/auth'
import { apiRoute, forbidden, jsonError, jsonOk, unauthorized } from '@/lib/engine/http'
import { runEvaluation } from '@/lib/engine/ml'

const Body = z.object({ seed: z.number().int().min(1).max(2_147_483_647).optional() })

export const POST = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN', 'ANALYST')) return forbidden()

  let seed = 42
  const raw = await req.text()
  if (raw.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
    }
    const body = Body.safeParse(parsed)
    if (!body.success) return jsonError(400, 'INVALID_BODY', 'seed must be an integer')
    if (body.data.seed !== undefined) seed = body.data.seed
  }
  const evaluation = await runEvaluation(seed)
  return jsonOk(evaluation)
})
