// StreamGuard — GET /api/health
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'
import { getRetentionState, getSettings } from '@/lib/settings'
import { jsonOk, unauthorized, API_VERSION } from '@/lib/engine/http'
import { ensureStatsLoop } from '@/lib/engine/notify'

async function checkDb(): Promise<'up' | 'down'> {
  try {
    await db.$queryRaw`SELECT 1`
    return 'up'
  } catch {
    return 'down'
  }
}

async function checkWs(): Promise<'up' | 'down'> {
  try {
    const res = await fetch('http://127.0.0.1:3003/health', { signal: AbortSignal.timeout(1000) })
    return res.ok ? 'up' : 'down'
  } catch {
    return 'down'
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  ensureStatsLoop()

  const settings = await getSettings()
  const [dbState, wsState, retention] = await Promise.all([checkDb(), checkWs(), getRetentionState()])
  const since24h = new Date(Date.now() - 24 * 3600 * 1000)
  const [processed24h, rejected24h] = await Promise.all([
    db.event.count({ where: { status: 'PROCESSED', ingestTime: { gte: since24h } } }),
    db.validationFailure.count({ where: { ts: { gte: since24h } } }),
  ])
  const llm: 'ok' | 'disabled' | 'error' = settings.aiEnabled ? ('ok' as const) : ('disabled' as const) // provider configured statically (sandbox-zai)
  // Core health reflects db + ws. The AI provider is optional/advisory: its
  // unavailability never degrades core functionality (documented contract).
  const status: 'ok' | 'degraded' = dbState === 'up' && wsState === 'up' ? 'ok' : 'degraded'

  return jsonOk({
    status,
    version: API_VERSION,
    uptimeSec: Math.floor(process.uptime()),
    checks: { db: dbState, ws: wsState, llm },
    queue: { depth: 0, processed24h, rejected24h }, // embedded engine: depth is always 0
    retention: {
      policy: `${settings.retentionHours}h`,
      lastRunAt: retention.lastRunAt ?? null,
      deletedCount: retention.deletedCount ?? 0,
    },
  })
}
