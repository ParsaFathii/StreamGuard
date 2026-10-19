// StreamGuard — GET/PATCH /api/incidents/[id]
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { audit, requireRole, requireSession } from '@/lib/auth'
import { forbidden, jsonError, jsonOk, notFound, unauthorized } from '@/lib/engine/http'
import { serializeIncident } from '@/lib/engine/serialize'
import { canTransition } from '@/lib/engine/incidents'
import { notify } from '@/lib/engine/notify'

const INC_ID_RE = /^INC-\d{1,6}$/

async function loadIncident(id: string) {
  return db.incident.findUnique({ where: { id } })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  const { id } = await params
  if (!INC_ID_RE.test(id)) return notFound('incident')
  const incident = await loadIncident(id)
  if (!incident) return notFound('incident')

  const [events, detections, notes, statusHistory, aiReports] = await Promise.all([
    db.incidentEvent.findMany({ where: { incidentId: id }, take: 200, orderBy: { addedAt: 'asc' } }),
    db.detection.findMany({ where: { incidentId: id }, orderBy: { createdAt: 'asc' }, take: 200 }),
    db.incidentNote.findMany({ where: { incidentId: id }, orderBy: { createdAt: 'asc' }, take: 200 }),
    db.incidentStatusHistory.findMany({ where: { incidentId: id }, orderBy: { ts: 'asc' }, take: 200 }),
    db.llmReport.findMany({ where: { incidentId: id }, orderBy: { ts: 'desc' }, take: 20, select: { id: true, ts: true, providerStatus: true } }),
  ])
  const eventIds = events.map((e) => e.eventId)
  const eventRows = eventIds.length > 0 ? await db.event.findMany({ where: { id: { in: eventIds } } }) : []
  const byId = new Map(eventRows.map((r) => [r.id, r]))

  return jsonOk({
    ...serializeIncident(incident),
    events: events
      .map((link) => {
        const e = byId.get(link.eventId)
        if (!e) return null
        return {
          id: e.id,
          eventTime: e.eventTime.toISOString(),
          severity: e.severity,
          category: e.category,
          sourceId: e.sourceId,
          actor: e.actor,
          message: e.message,
          correlationId: e.correlationId,
          late: link.late,
        }
      })
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .sort((a, b) => a.eventTime.localeCompare(b.eventTime)),
    detections: detections.map((d) => ({
      id: d.id,
      ruleId: d.ruleId,
      eventId: d.eventId,
      incidentId: d.incidentId,
      severity: d.severity,
      score: d.score,
      title: d.title,
      detail: JSON.parse(d.detailJson) as Record<string, unknown>,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
    })),
    notes: notes.map((n) => ({ id: n.id, author: n.author, body: n.body, createdAt: n.createdAt.toISOString() })),
    statusHistory: statusHistory.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actor: h.actor,
      note: h.note,
      ts: h.ts.toISOString(),
    })),
    aiReports: aiReports.map((r) => ({ id: r.id, ts: r.ts.toISOString(), providerStatus: r.providerStatus })),
  })
}

const PatchBody = z
  .object({
    status: z.enum(['NEW', 'TRIAGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED']).optional(),
    assignedTo: z.string().min(1).max(64).optional(),
    resolutionSummary: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' })

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await requireSession(req)
  if (!session) return unauthorized()
  if (!requireRole(session, 'ADMIN', 'ANALYST')) return forbidden()
  const { id } = await params
  if (!INC_ID_RE.test(id)) return notFound('incident')

  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, 'INVALID_BODY', 'Request body must be JSON')
  }
  const body = PatchBody.safeParse(parsed)
  if (!body.success) {
    return jsonError(400, 'INVALID_BODY', body.error.issues[0]?.message ?? 'invalid incident patch')
  }

  const incident = await loadIncident(id)
  if (!incident) return notFound('incident')

  const changes: Record<string, unknown> = {}

  if (body.data.assignedTo !== undefined && body.data.assignedTo !== incident.assignedTo) {
    changes.assignedTo = { from: incident.assignedTo, to: body.data.assignedTo }
  }

  let statusChanged = false
  if (body.data.status !== undefined && body.data.status !== incident.status) {
    statusChanged = true
    const target = body.data.status
    if (!canTransition(incident.status, target)) {
      return jsonError(400, 'INVALID_TRANSITION', `invalid transition ${incident.status} -> ${target}`)
    }
    if (target === 'RESOLVED') {
      const summary = (body.data.resolutionSummary ?? incident.resolutionSummary ?? '').trim()
      if (summary.length < 10) {
        return jsonError(400, 'RESOLUTION_REQUIRED', 'resolving requires a resolutionSummary of at least 10 characters')
      }
    }
    if (incident.status === 'CLOSED' && target === 'INVESTIGATING' && session.user.role !== 'ADMIN') {
      // reopening a closed incident is ADMIN-only
      return forbidden()
    }
    changes.status = { from: incident.status, to: target }
    if (body.data.resolutionSummary !== undefined && body.data.resolutionSummary !== incident.resolutionSummary) {
      changes.resolutionSummary = { from: incident.resolutionSummary, to: body.data.resolutionSummary }
    }
  } else if (body.data.resolutionSummary !== undefined && body.data.resolutionSummary !== incident.resolutionSummary) {
    changes.resolutionSummary = { from: incident.resolutionSummary, to: body.data.resolutionSummary }
  }

  if (Object.keys(changes).length === 0) {
    return jsonOk({ ...serializeIncident(incident), unchanged: true })
  }

  const now = new Date()
  const data: Record<string, unknown> = {}
  if (changes.assignedTo) data.assignedTo = (changes.assignedTo as { to: string }).to
  if (changes.resolutionSummary) data.resolutionSummary = (changes.resolutionSummary as { to: string }).to
  if (statusChanged) {
    const target = (changes.status as { to: string }).to
    data.status = target
    if (target === 'RESOLVED') data.resolvedAt = now
    if (target === 'CLOSED') data.closedAt = now
    data.updatedAt = now
  } else {
    data.updatedAt = now
  }

  const updated = await db.incident.update({ where: { id }, data })
  if (statusChanged) {
    await db.incidentStatusHistory.create({
      data: {
        incidentId: id,
        fromStatus: incident.status,
        toStatus: (changes.status as { to: string }).to,
        actor: session.user.username,
        note: body.data.resolutionSummary ?? null,
        ts: now,
      },
    })
  }
  await audit({
    actor: session.user.username,
    role: session.user.role,
    action: 'incident.update',
    targetType: 'incident',
    targetId: id,
    details: changes,
  })
  void notify('incident:update', serializeIncident(updated))
  return jsonOk(serializeIncident(updated))
}
