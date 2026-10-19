// StreamGuard — detection -> incident correlation.
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Correlation: an OPEN (NEW/TRIAGED/INVESTIGATING) incident with the same
// ruleId + correlation value, updated within settings.correlationWindowSeconds,
// absorbs the detection; otherwise a new sequential incident is created
// (INC-000001 format via the IncidentCounter table). Late events
// (event_time older than the correlation window) still attach, flagged late.
import { db } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { maxSeverity, type EngineCtx } from '@/lib/engine/types'
import type { CreatedDetection } from '@/lib/engine/rules'

export interface CorrelateOutcome {
  incidentId: string
  created: boolean
  incident: Record<string, unknown> // serialized summary for notify payloads
}

const OPEN_STATUSES = ['NEW', 'TRIAGED', 'INVESTIGATING'] as const

export async function nextIncidentId(): Promise<string> {
  const counter = await db.incidentCounter.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', count: 1 },
    update: { count: { increment: 1 } },
  })
  return `INC-${String(counter.count).padStart(6, '0')}`
}

function serializeIncident(i: {
  id: string; title: string; severity: string; status: string; ruleId: string
  correlationKey: string; correlationLabel: string; eventCount: number; detectionCount: number
  firstEventTime: Date | null; lastEventTime: Date | null; assignedTo: string | null
  resolutionSummary: string | null; createdAt: Date; updatedAt: Date
}): Record<string, unknown> {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    ruleId: i.ruleId,
    correlationKey: i.correlationKey,
    correlationLabel: i.correlationLabel,
    eventCount: i.eventCount,
    detectionCount: i.detectionCount,
    firstEventTime: i.firstEventTime?.toISOString() ?? null,
    lastEventTime: i.lastEventTime?.toISOString() ?? null,
    assignedTo: i.assignedTo,
    resolutionSummary: i.resolutionSummary,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  }
}

export async function correlateDetection(det: CreatedDetection, ctx: EngineCtx): Promise<CorrelateOutcome> {
  const settings = await getSettings()
  const windowMs = settings.correlationWindowSeconds * 1000
  const since = new Date(ctx.now.getTime() - windowMs)

  const attachEvents = det.attachEventIds.length
    ? await db.event.findMany({ where: { id: { in: det.attachEventIds } } })
    : []

  const existing = await db.incident.findFirst({
    where: {
      ruleId: det.ruleId,
      correlationKey: det.cv,
      status: { in: OPEN_STATUSES as unknown as string[] },
      updatedAt: { gte: since },
    },
    orderBy: { updatedAt: 'desc' },
  })

  if (existing) {
    const alreadyLinked = new Set(
      (await db.incidentEvent.findMany({ where: { incidentId: existing.id }, select: { eventId: true } })).map((r) => r.eventId),
    )
    const newLinks = attachEvents.filter((e) => !alreadyLinked.has(e.id))
    if (newLinks.length > 0) {
      await db.incidentEvent.createMany({
        data: newLinks.map((e) => ({
          incidentId: existing.id,
          eventId: e.id,
          late: e.eventTime.getTime() < ctx.now.getTime() - windowMs,
          addedAt: ctx.now,
        })),
      })
    }
    const firstEventTime = attachEvents.reduce<Date | null>(
      (acc, e) => (!acc || e.eventTime < acc ? e.eventTime : acc),
      existing.firstEventTime,
    )
    const lastEventTime = attachEvents.reduce<Date | null>(
      (acc, e) => (!acc || e.eventTime > acc ? e.eventTime : acc),
      existing.lastEventTime,
    )
    const updated = await db.incident.update({
      where: { id: existing.id },
      data: {
        severity: maxSeverity(existing.severity, det.ruleSeverity),
        detectionCount: { increment: 1 },
        eventCount: { increment: newLinks.length },
        firstEventTime: firstEventTime ?? existing.firstEventTime,
        lastEventTime: lastEventTime ?? existing.lastEventTime,
        updatedAt: ctx.now,
      },
    })
    await db.detection.update({ where: { id: det.id }, data: { incidentId: existing.id } })
    return { incidentId: existing.id, created: false, incident: serializeIncident(updated) }
  }

  const id = await nextIncidentId()
  const created = await db.incident.create({
    data: {
      id,
      title: `${det.ruleName} — ${det.cv}`,
      severity: det.ruleSeverity,
      status: 'NEW',
      ruleId: det.ruleId,
      correlationKey: det.cv,
      correlationLabel: det.ckey,
      eventCount: attachEvents.length,
      detectionCount: 1,
      firstEventTime: attachEvents.length ? attachEvents.reduce((a, e) => (e.eventTime < a ? e.eventTime : a), attachEvents[0].eventTime) : null,
      lastEventTime: attachEvents.length ? attachEvents.reduce((a, e) => (e.eventTime > a ? e.eventTime : a), attachEvents[0].eventTime) : null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    },
  })
  await db.incidentStatusHistory.create({
    data: { incidentId: id, fromStatus: null, toStatus: 'NEW', actor: 'system', ts: ctx.now },
  })
  if (attachEvents.length > 0) {
    await db.incidentEvent.createMany({
      data: attachEvents.map((e) => ({
        incidentId: id,
        eventId: e.id,
        late: e.eventTime.getTime() < ctx.now.getTime() - windowMs,
        addedAt: ctx.now,
      })),
    })
  }
  await db.detection.update({ where: { id: det.id }, data: { incidentId: id } })
  return { incidentId: id, created: true, incident: serializeIncident(created) }
}
