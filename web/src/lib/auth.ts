// StreamGuard — demo-grade session auth.
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// DEMO-GRADE, DOCUMENTED AS SUCH:
// - Session tokens are HMAC-SHA256 signed strings (`sg1.<sid>.<exp>.<sig>`),
//   stored in the Session table, delivered as the HttpOnly cookie `sg_session`
//   (7 days) or `Authorization: Bearer <token>` for API use.
// - Passwords are stored as sha256(salt + password) — demo-grade by design;
//   NOT for production (bcrypt/argon2 would be used there).
import crypto from 'node:crypto'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import type { Role } from '@/lib/types'

// SESSION_SECRET comes from env; safe default so the demo never hard-fails.
const SECRET = process.env.SESSION_SECRET || 'sg-demo-session-secret-2026-change-me'
export const SESSION_TTL_SEC = 7 * 24 * 3600
export const SESSION_COOKIE = 'sg_session'

function hmac(value: string): string {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// ---- passwords (demo-grade: sha256(salt + password)) ----
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex')
  return `p0$${salt}$${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$')
    if (parts.length !== 3 || parts[0] !== 'p0') return false
    const hash = crypto.createHash('sha256').update(parts[1] + password).digest('hex')
    return safeEqual(hash, parts[2])
  } catch {
    return false
  }
}

// ---- ingest key hashing (sha256(keyId + ':' + key), stored hashed) ----
export function hashIngestKey(keyId: string, key: string): string {
  return crypto.createHash('sha256').update(`${keyId}:${key}`).digest('hex')
}

// ---- sessions ----
export interface SessionUser {
  id: string
  username: string
  role: Role
  displayName: string
}

export interface AuthSession {
  sessionId: string
  token: string
  user: SessionUser
}

export async function createSession(userId: string): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const sid = crypto.randomBytes(18).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000)
  const expStr = String(expiresAt.getTime())
  const base = `sg1.${sid}.${expStr}`
  const token = `${base}.${hmac(base)}`
  const row = await db.session.create({ data: { token, userId, expiresAt } })
  return { token, sessionId: row.id, expiresAt }
}

export async function destroySession(token: string): Promise<void> {
  try {
    await db.session.deleteMany({ where: { token } })
  } catch {
    // already gone — logout is idempotent
  }
}

export function extractToken(req: NextRequest): string | null {
  const cookie = req.cookies.get(SESSION_COOKIE)?.value
  if (cookie) return cookie
  const header = req.headers.get('authorization')
  if (header && header.toLowerCase().startsWith('bearer ')) {
    const t = header.slice(7).trim()
    return t.length > 0 ? t : null
  }
  return null
}

export async function requireSession(req: NextRequest): Promise<AuthSession | null> {
  const token = extractToken(req)
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'sg1') return null
  const [, sid, expStr, sig] = parts
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || !Number.isInteger(exp)) return null
  if (!safeEqual(hmac(`sg1.${sid}.${expStr}`), sig)) return null
  if (Date.now() > exp) return null
  try {
    const session = await db.session.findUnique({ where: { token } })
    if (!session) return null
    if (session.expiresAt.getTime() < Date.now()) {
      await db.session.deleteMany({ where: { token } }).catch(() => undefined)
      return null
    }
    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user) return null
    return {
      sessionId: session.id,
      token,
      user: { id: user.id, username: user.username, role: user.role as Role, displayName: user.displayName },
    }
  } catch {
    return null
  }
}

export function requireRole(session: AuthSession, ...roles: Role[]): boolean {
  return roles.includes(session.user.role)
}

// ---- audit log (never throws) ----
export interface AuditInput {
  actor: string
  role: string
  action: string
  targetType?: string
  targetId?: string
  details?: Record<string, unknown>
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actor: input.actor,
        role: input.role,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        details: JSON.stringify(input.details ?? {}),
      },
    })
  } catch {
    // auditing must never break the request
  }
}

export function sessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SEC,
  }
}
