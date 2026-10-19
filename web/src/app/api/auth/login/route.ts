// StreamGuard — POST /api/auth/login
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { audit, createSession, sessionCookieOptions, verifyPassword } from '@/lib/auth'
import { apiRoute, jsonError, jsonOk } from '@/lib/engine/http'

const Body = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
})

export const POST = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
  }
  const body = Body.safeParse(parsed)
  if (!body.success) {
    return jsonError(400, 'INVALID_BODY', 'username and password are required')
  }
  const user = await db.user.findUnique({ where: { username: body.data.username } })
  if (!user || !verifyPassword(body.data.password, user.passwordHash)) {
    void audit({
      actor: body.data.username,
      role: user?.role ?? 'UNKNOWN',
      action: 'login',
      details: { success: false, reason: 'invalid credentials' },
    })
    return jsonError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
  }
  const session = await createSession(user.id)
  await audit({
    actor: user.username,
    role: user.role,
    action: 'login',
    targetType: 'session',
    targetId: session.sessionId,
    details: { success: true },
  })
  const res = jsonOk({
    user: { username: user.username, role: user.role, displayName: user.displayName },
  })
  res.cookies.set({ ...sessionCookieOptions(), value: session.token })
  return res
})
