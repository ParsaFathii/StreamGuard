// StreamGuard — POST /api/simulator/scenario {scenarioId, seed?} (ANALYST+)
// Copyright © 2026 Parsa Fathi — Apache-2.0
// Deterministic per (scenario, seed): same inputs -> same event pattern
// (event ids are fresh UUIDs by design — they are idempotency keys).
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { apiRoute, forbidden, jsonError, jsonOk, unauthorized } from '@/lib/engine/http'
import { getScenario, mulberry32 } from '@/lib/engine/simulator'
import { ingestEvents } from '@/lib/engine/pipeline'
import { notify } from '@/lib/engine/notify'

const Body = z.object({
  scenarioId: z.string().min(1).max(64),
  seed: z.number().int().min(1).max(2_147_483_647).optional(),
})

function runId(): string {
  return `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const POST = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN', 'ANALYST')) return forbidden()

  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
  }
  const body = Body.safeParse(parsed)
  if (!body.success) return jsonError(400, 'INVALID_BODY', 'scenarioId is required, seed optional integer')

  const scenario = getScenario(body.data.scenarioId)
  if (!scenario) return jsonError(400, 'UNKNOWN_SCENARIO', `Unknown scenarioId '${body.data.scenarioId}'`)

  const seed = body.data.seed ?? 42
  const rng = mulberry32(seed)
  const raws = scenario.generate(rng, new Date())
  const id = runId()
  void notify('simulator', { runId: id, scenarioId: scenario.id, phase: 'start', ts: new Date().toISOString() })

  const result = await ingestEvents(raws, { origin: 'synthetic' })

  void notify('simulator', { runId: id, scenarioId: scenario.id, phase: 'done', generated: raws.length, accepted: result.accepted, rejected: result.rejected, ts: new Date().toISOString() })
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'simulator.run',
    targetType: 'simulator',
    targetId: scenario.id,
    details: { runId: id, seed, generated: raws.length, accepted: result.accepted, duplicates: result.duplicates, rejected: result.rejected },
  })
  return jsonOk({
    runId: id,
    generated: raws.length,
    eventIds: result.eventIds,
    accepted: result.accepted,
    duplicates: result.duplicates,
    rejected: result.rejected,
    rejectedItems: result.rejectedItems,
    expectedDetections: scenario.expectedDetections,
    expectedIncidentSeverity: scenario.expectedIncidentSeverity,
    note: scenario.note ?? `Scenario '${scenario.id}' generated ${raws.length} events (seed ${seed}).`,
  })
})
