// StreamGuard — DB row -> API JSON serializers (typed shapes from src/lib/types.ts).
// Copyright © 2026 Parsa Fathi — Apache-2.0
import type { Prisma } from '@prisma/client'
import type { Detection, Incident, SgEvent } from '@/lib/types'

type EventRow = Prisma.EventGetPayload<object>
type DetectionRow = Prisma.DetectionGetPayload<object>
type IncidentRow = Prisma.IncidentGetPayload<object>

function parseJson(s: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return fallback
  }
}

export function serializeEvent(row: EventRow): SgEvent {
  return {
    id: row.id,
    schemaVersion: row.schemaVersion,
    eventTime: row.eventTime.toISOString(),
    ingestTime: row.ingestTime.toISOString(),
    sourceId: row.sourceId,
    sourceType: row.sourceType as SgEvent['sourceType'],
    severity: row.severity as SgEvent['severity'],
    category: row.category as SgEvent['category'],
    message: row.message,
    attributes: parseJson(row.attributesJson, {}),
    correlationId: row.correlationId,
    traceId: row.traceId,
    actor: row.actor,
    origin: row.origin as SgEvent['origin'],
    status: row.status as SgEvent['status'],
    rejectionReason: row.rejectionReason,
    latencyMs: row.latencyMs,
  }
}

export function serializeDetection(row: DetectionRow): Detection {
  return {
    id: row.id,
    ruleId: row.ruleId,
    eventId: row.eventId,
    incidentId: row.incidentId,
    severity: row.severity as Detection['severity'],
    score: row.score,
    title: row.title,
    detail: parseJson(row.detailJson, {}) as Detection['detail'],
    status: row.status as Detection['status'],
    createdAt: row.createdAt.toISOString(),
  }
}

export function serializeIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    title: row.title,
    severity: row.severity as Incident['severity'],
    status: row.status as Incident['status'],
    ruleId: row.ruleId,
    correlationKey: row.correlationKey,
    correlationLabel: row.correlationLabel,
    eventCount: row.eventCount,
    detectionCount: row.detectionCount,
    firstEventTime: row.firstEventTime?.toISOString() ?? null,
    lastEventTime: row.lastEventTime?.toISOString() ?? null,
    assignedTo: row.assignedTo,
    resolutionSummary: row.resolutionSummary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
