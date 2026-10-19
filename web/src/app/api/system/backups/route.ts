// StreamGuard — GET/POST /api/system/backups (ADMIN)
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// GET  → { dir, keep, scheduleHours, lastRunAt, lastResult, backups: [...] }
// POST → create a backup now (audited as 'backup.create'); 500 BACKUP_FAILED
//        with the reason if the snapshot could not be taken.
import { NextResponse, type NextRequest } from 'next/server'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { apiRoute, forbidden, jsonError, jsonOk, unauthorized } from '@/lib/engine/http'
import { BACKUP_INTERVAL_MS, KEEP_BACKUPS, createBackup, listBackups } from '@/lib/engine/backups'
import { getBackupState } from '@/lib/settings'

export const GET = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN')) return forbidden()
  const state = await getBackupState()
  return jsonOk({
    ...listBackups(),
    scheduleHours: Math.round(BACKUP_INTERVAL_MS / 3_600_000),
    lastRunAt: state.lastRunAt ?? null,
    lastResult: state.lastResult ?? null,
  })
})

export const POST = apiRoute(async (req: NextRequest): Promise<NextResponse> => {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN')) return forbidden()
  const result = await createBackup()
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'backup.create',
    targetType: 'backup',
    targetId: result.file ?? undefined,
    details: result.ok
      ? { sizeBytes: result.sizeBytes ?? null, durationMs: result.durationMs ?? null, keep: KEEP_BACKUPS }
      : { error: result.error ?? 'unknown' },
  })
  if (!result.ok) return jsonError(500, 'BACKUP_FAILED', result.error ?? 'backup failed')
  return jsonOk(result, 201)
})
