// StreamGuard — GET /api/metrics (Prometheus text format)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { requireSession } from '@/lib/auth'
import { API_VERSION } from '@/lib/engine/http'
import { renderPrometheus } from '@/lib/engine/metrics'
import { ensureStatsLoop } from '@/lib/engine/notify'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession(req)
  if (session) ensureStatsLoop()
  const text = await renderPrometheus()
  return new NextResponse(text, {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'X-StreamGuard-Version': API_VERSION,
    },
  })
}
