// StreamGuard — POST /api/auth/logout (idempotent; audited when a session existed)
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { audit, destroySession, requireSession, sessionCookieOptions } from '@/lib/auth'
import { apiRoute, jsonOk } from '@/lib/engine/http'

export const POST = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (session) {
    await destroySession(session.token)
    await audit({ actor: session.user.username, role: session.user.role, action: 'logout' })
  }
  const res = jsonOk({ ok: true })
  res.cookies.set({ ...sessionCookieOptions(), value: '', maxAge: 0 })
  return res
})
