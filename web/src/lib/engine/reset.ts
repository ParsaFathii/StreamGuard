// StreamGuard — demo reset: wipe dynamic tables + re-seed a light baseline.
// Copyright © 2026 Parsa Fathi — Apache-2.0
// Keeps users, rules, settings, sessions, ingest keys and the incident counter
// (incident ids are never reused after a wipe).
import { db } from '@/lib/db'
import { generateBaseline, mulberry32 } from '@/lib/engine/simulator'
import { ingestHistorical } from '@/lib/engine/history'

export async function wipeDynamicTables(): Promise<void> {
  await db.incidentEvent.deleteMany({})
  await db.incidentNote.deleteMany({})
  await db.incidentStatusHistory.deleteMany({})
  await db.detection.deleteMany({})
  await db.incident.deleteMany({})
  await db.validationFailure.deleteMany({})
  await db.event.deleteMany({})
  await db.auditLog.deleteMany({})
  await db.metric.deleteMany({})
  await db.mlRun.deleteMany({})
  await db.llmReport.deleteMany({})
}

/** ~45 minutes of clean baseline ending ~1 min before now (charts-friendly). */
export async function seedLightBaseline(): Promise<{ events: number; chunks: number }> {
  const rng = mulberry32(20260101)
  const raws: Array<Record<string, unknown>> = []
  const endMs = Date.now() - 60_000
  const minutes = 45
  for (let m = minutes; m >= 1; m--) {
    const minuteEnd = new Date(endMs - (m - 1) * 60_000)
    const count = 4 + Math.floor(rng() * 5) // 4..8 events per minute
    raws.push(...generateBaseline(rng, minuteEnd, count, 60))
  }
  const summary = await ingestHistorical(raws, { notify: true })
  return { events: summary.accepted, chunks: summary.chunks }
}
