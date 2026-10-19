// StreamGuard — GET /api/auth/session
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { requireSession } from '@/lib/auth'
import { apiRoute, jsonError, jsonOk } from '@/lib/engine/http'

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return jsonError(401, 'UNAUTHORIZED', 'Authentication required')
  return jsonOk({
    user: { username: session.user.username, role: session.user.role, displayName: session.user.displayName },
  })
})
