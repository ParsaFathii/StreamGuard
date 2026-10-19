// StreamGuard — retention sweeps (configurable, observable, safe).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Deletes events older than settings.retentionHours EXCEPT events linked to
// non-CLOSED incidents. Deletions counted + audited (action: retention.run).
// Runs on demand (POST /api/system/retention-run) and automatically at most
// every 5 minutes, triggered by ingest.
import { db } from '@/lib/db'
import { getRetentionState, getSettings, setRetentionState } from '@/lib/settings'
import { audit } from '@/lib/auth'

export interface RetentionResult {
  deleted: number
  protectedEvents: number
  cutoff: string
}

export async function runRetention(now = new Date()): Promise<RetentionResult> {
  const settings = await getSettings()
  const cutoff = new Date(now.getTime() - settings.retentionHours * 3600 * 1000)

  // events linked to non-CLOSED incidents must never be deleted
  const openIncidents = await db.incident.findMany({ where: { status: { not: 'CLOSED' } }, select: { id: true } })
  let protectedIds: string[] = []
  if (openIncidents.length > 0) {
    const links = await db.incidentEvent.findMany({
      where: { incidentId: { in: openIncidents.map((i) => i.id) } },
      select: { eventId: true },
      take: 20000,
    })
    protectedIds = Array.from(new Set(links.map((l) => l.eventId)))
  }

  const doomed = await db.event.findMany({
    where: { eventTime: { lt: cutoff }, ...(protectedIds.length > 0 ? { id: { notIn: protectedIds } } : {}) },
    select: { id: true },
    take: 20000,
  })
  let deletedCount = 0
  if (doomed.length > 0) {
    const doomedIds = doomed.map((d) => d.id)
    await db.event.deleteMany({ where: { id: { in: doomedIds } } })
    await db.incidentEvent.deleteMany({ where: { eventId: { in: doomedIds } } }) // purge orphan links
    deletedCount = doomedIds.length
  }

  // state keeps the per-run deletedCount and a cumulative totalDeleted (durable)
  const prev = await getRetentionState()
  await setRetentionState({
    lastRunAt: now.toISOString(),
    deletedCount,
    totalDeleted: (prev.totalDeleted ?? 0) + deletedCount,
  })
  // every run is audited (observability) with its real deletedCount
  await audit({
    actor: 'system',
    role: 'SYSTEM',
    action: 'retention.run',
    targetType: 'retention',
    details: { deletedCount, protectedEvents: protectedIds.length, cutoff: cutoff.toISOString() },
  })
  return { deleted: deletedCount, protectedEvents: protectedIds.length, cutoff: cutoff.toISOString() }
}

// ---- automatic check (at most every 5 min, triggered by ingest) ----
interface RetentionLoopState {
  lastAt: number
  running: boolean
}
const g = globalThis as unknown as { __sgRetentionLoop?: RetentionLoopState }
const state: RetentionLoopState = g.__sgRetentionLoop ?? (g.__sgRetentionLoop = { lastAt: 0, running: false })

export function maybeRunRetention(): void {
  const now = Date.now()
  if (state.running || now - state.lastAt < 5 * 60 * 1000) return
  state.lastAt = now
  state.running = true
  void runRetention()
    .catch(() => undefined)
    .finally(() => {
      state.running = false
    })
}
