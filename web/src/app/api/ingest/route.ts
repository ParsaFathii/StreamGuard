// StreamGuard — POST /api/ingest
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Auth: ADMIN/ANALYST session OR valid ingest key in the X-Ingest-Key header.
// The seeded demo key (documented for the demo; stored hashed as
// sha256(keyId + ':' + key) — keyId "demo-key-01", key value
// "sg-demo-ingest-key-2026"): external systems use the header, demo simulator
// traffic uses the session path.
// Origin policy (server-assigned): session ingest -> "synthetic",
// ingest-key ingest -> "external".
// Limits: body <= 256 KB, batch <= settings.maxBatchSize (100), single event
// <= 4 KB, rate limit settings.rateLimitPerMin per identity (429 + Retry-After).
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit, hashIngestKey, requireSession } from '@/lib/auth'
import { getSettings } from '@/lib/settings'
import { checkRateLimit } from '@/lib/rate-limit'
import { MAX_BODY_BYTES } from '@/lib/validation'
import { ingestEvents, ingestResponse } from '@/lib/engine/pipeline'
import { countIngest } from '@/lib/engine/proc-stats'
import { jsonError, jsonOk } from '@/lib/engine/http'

type IngestIdentity =
  | { kind: 'session'; username: string; role: string }
  | { kind: 'key'; keyId: string }

async function resolveIdentity(req: NextRequest): Promise<{ identity: IngestIdentity } | { error: 'unauthorized' } | { error: 'forbidden' }> {
  const headerKey = req.headers.get('x-ingest-key')
  if (headerKey) {
    const keys = await db.ingestKey.findMany({ where: { active: true } })
    for (const k of keys) {
      if (hashIngestKey(k.keyId, headerKey) === k.keyHash) {
        void db.ingestKey.update({ where: { id: k.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)
        return { identity: { kind: 'key', keyId: k.keyId } }
      }
    }
    return { error: 'unauthorized' }
  }
  const session = await requireSession(req)
  if (!session) return { error: 'unauthorized' }
  if (session.user.role !== 'ADMIN' && session.user.role !== 'ANALYST') return { error: 'forbidden' }
  return { identity: { kind: 'session', username: session.user.username, role: session.user.role } }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const settings = await getSettings()
  const resolved = await resolveIdentity(req)
  if ('error' in resolved) {
    countIngest(resolved.error === 'unauthorized' ? 401 : 403)
    return resolved.error === 'unauthorized'
      ? jsonError(401, 'UNAUTHORIZED', 'Provide a valid X-Ingest-Key header or an ADMIN/ANALYST session')
      : jsonError(403, 'FORBIDDEN', 'Ingest requires ADMIN/ANALYST session or an ingest key')
  }
  const identity = resolved.identity
  const rlKey = `ingest:${identity.kind === 'key' ? `key:${identity.keyId}` : `user:${identity.username}`}`
  const rl = checkRateLimit(rlKey, settings.rateLimitPerMin)
  if (!rl.allowed) {
    countIngest(429)
    return jsonError(429, 'RATE_LIMITED', `Ingest rate limit exceeded (${settings.rateLimitPerMin}/min)`, {
      'Retry-After': String(rl.retryAfterSec),
    })
  }

  let raw: unknown
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) {
    countIngest(413)
    return jsonError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  try {
    raw = JSON.parse(text)
  } catch {
    countIngest(400)
    return jsonError(400, 'INVALID_BODY', 'Request body must be valid JSON')
  }

  let raws: unknown[]
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'batch' in (raw as Record<string, unknown>)) {
    const batch = (raw as Record<string, unknown>).batch
    if (!Array.isArray(batch)) {
      countIngest(400)
      return jsonError(400, 'INVALID_BODY', 'batch must be an array of events')
    }
    if (batch.length === 0) {
      countIngest(400)
      return jsonError(400, 'INVALID_BODY', 'batch must not be empty')
    }
    if (batch.length > settings.maxBatchSize) {
      countIngest(413)
      return jsonError(413, 'BATCH_TOO_LARGE', `batch exceeds maxBatchSize=${settings.maxBatchSize}`)
    }
    raws = batch
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    raws = [raw] // single event object
  } else {
    countIngest(400)
    return jsonError(400, 'INVALID_BODY', 'Body must be a single event object or {"batch": [events]}')
  }

  const result = await ingestEvents(raws, {
    origin: identity.kind === 'key' ? 'external' : 'synthetic',
  })
  countIngest(202)

  // key-based ingest audited, sampled 1-in-20 (documented)
  if (identity.kind === 'key' && Math.floor(Math.random() * 20) === 0) {
    void audit({
      actor: `ingest-key:${identity.keyId}`,
      role: 'INGEST_KEY',
      action: 'ingest',
      targetType: 'ingest',
      details: { accepted: result.accepted, duplicates: result.duplicates, rejected: result.rejected, sampled: true },
    })
  }

  return jsonOk(ingestResponse(result), 202)
}
