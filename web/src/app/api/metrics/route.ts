// StreamGuard — GET /api/metrics (Prometheus text format)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { requireSession } from '@/lib/auth'
import { API_VERSION, apiRoute, unauthorized } from '@/lib/engine/http'
import { renderPrometheus } from '@/lib/engine/metrics'
import { ensureStatsLoop } from '@/lib/engine/notify'

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  // any authenticated session (VIEWER+) — matches /api/health and every other
  // data endpoint; anonymous Prometheus scraping is not supported (CONTRACT §System)
  const session = await requireSession(req)
  if (!session) return unauthorized()
  ensureStatsLoop()
  const text = await renderPrometheus()
  return new NextResponse(text, {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'X-StreamGuard-Version': API_VERSION,
    },
  })
})
