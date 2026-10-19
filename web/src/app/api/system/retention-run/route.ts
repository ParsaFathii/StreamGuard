// StreamGuard — POST /api/system/retention-run (ADMIN)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { requireRole, requireSession } from '@/lib/auth'
import { forbidden, jsonOk, unauthorized } from '@/lib/engine/http'
import { runRetention } from '@/lib/engine/retention'
import { getSettings } from '@/lib/settings'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN')) return forbidden()
  // runRetention audits (action: retention.run) and records state internally
  const result = await runRetention()
  const settings = await getSettings()
  return jsonOk({
    ok: true,
    deleted: result.deleted,
    deletedCount: result.deleted, // contract name (frontend field)
    protectedEvents: result.protectedEvents,
    cutoff: result.cutoff,
    policyHours: settings.retentionHours,
  })
}
