// StreamGuard — embedded processing pipeline (ingest -> validate -> store ->
// rules -> correlate -> notify -> mark PROCESSED).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// One call = one ingest request (single event or batch). Used by:
//   POST /api/ingest, the simulator routes, and prisma/seed.ts (historical replay).
// Processing latency: events of one call are stored with one ingestTime and
// processed together, so they share the measured latency (embedded engine
// batch semantics, documented).
import { db } from '@/lib/db'
import { extractSourceId, truncateSample, validateEventInput, type ValidatedEvent } from '@/lib/validation'
import { evaluateRulesForEvents, checkValidationFailures, type CreatedDetection } from '@/lib/engine/rules'
import { correlateDetection, type CorrelateOutcome } from '@/lib/engine/correlate'
import { compactEvent, notify, queueEventNotifications } from '@/lib/engine/notify'
import { markLastEvent, countDuplicates } from '@/lib/engine/proc-stats'
import { toStored, type EngineCtx, type StoredEvent } from '@/lib/engine/types'
import { maybeRunRetention } from '@/lib/engine/retention'
import { withEngineLock } from '@/lib/engine/lock'

export interface IngestOptions {
  /** processing "current time" (detection/incident timestamps, cooldowns) — historical for seed replay */
  now?: Date
  /** storage ingest timestamp — historical for seed replay */
  ingestTime?: Date
  /** data-origin marker assigned server-side (session ingest -> synthetic, ingest-key -> external) */
  origin?: 'synthetic' | 'external'
  /** emit WS notifications (false for seeding) */
  notify?: boolean
  /** seed mode: assign plausible per-event processing latency instead of wall-clock (documented demo replay) */
  historicalLatency?: boolean
}

export interface IngestResult {
  accepted: number
  duplicates: number
  rejected: number
  eventIds: string[]
  duplicateIds: string[]
  rejectedItems: Array<{ index: number; reason: string }>
  detections: CreatedDetection[]
  incidents: CorrelateOutcome[]
  processed: number
}

/**
 * Public entry point: the whole pipeline runs inside the engine mutex so that
 * validate -> store -> rules -> correlate is serialized per process (fixes the
 * cooldown/correlation/idempotency TOCTOU races). All callers (ingest route,
 * simulator routes, seed replay) MUST use this function; nothing may call
 * ingestEventsInner directly and no code may nest withEngineLock.
 */
export function ingestEvents(raws: unknown[], opts: IngestOptions = {}): Promise<IngestResult> {
  return withEngineLock(() => ingestEventsInner(raws, opts))
}

async function ingestEventsInner(raws: unknown[], opts: IngestOptions = {}): Promise<IngestResult> {
  const ctx: EngineCtx = { now: opts.now ?? new Date() }
  const ingestTime = opts.ingestTime ?? new Date()
  const origin = opts.origin ?? 'synthetic'
  const doNotify = opts.notify !== false

  const result: IngestResult = {
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    eventIds: [],
    duplicateIds: [],
    rejectedItems: [],
    detections: [],
    incidents: [],
    processed: 0,
  }

  // 1) validate + in-batch duplicate detection
  const valid: Array<{ index: number; event: ValidatedEvent }> = []
  const seenInBatch = new Set<string>()
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]
    const outcome = validateEventInput(raw)
    if (!outcome.ok) {
      result.rejected += 1
      result.rejectedItems.push({ index: i, reason: outcome.reason })
      try {
        await db.validationFailure.create({
          data: {
            ts: ctx.now,
            sourceId: extractSourceId(raw),
            reason: outcome.reason,
            details: JSON.stringify({ index: i, batchPosition: i }),
            payloadSample: truncateSample(raw, 256),
          },
        })
      } catch {
        // recording must not break ingest
      }
      continue
    }
    if (seenInBatch.has(outcome.event.event_id)) {
      result.duplicates += 1
      result.duplicateIds.push(outcome.event.event_id)
      continue
    }
    seenInBatch.add(outcome.event.event_id)
    valid.push({ index: i, event: outcome.event })
  }

  // 2) DB duplicate check (idempotency: no re-store, no re-detection)
  if (valid.length > 0) {
    const ids = valid.map((v) => v.event.event_id)
    const existing = await db.event.findMany({ where: { id: { in: ids } }, select: { id: true } })
    const existingSet = new Set(existing.map((e) => e.id))
    const fresh: Array<{ index: number; event: ValidatedEvent }> = []
    for (const v of valid) {
      if (existingSet.has(v.event.event_id)) {
        result.duplicates += 1
        result.duplicateIds.push(v.event.event_id)
      } else {
        fresh.push(v)
      }
    }
    valid.length = 0
    valid.push(...fresh)
  }

  // 3) store accepted events
  //    P2002 fallback (belt-and-braces with the engine lock): if a concurrent
  //    writer stored one of our ids first (multi-process edge, or a lock-free
  //    caller), classify per-row instead of failing the whole request.
  let storedRows: StoredEvent[] = []
  const storedIds: string[] = []
  if (valid.length > 0) {
    const rows = valid.map((v) => ({
      id: v.event.event_id,
      schemaVersion: 1,
      eventTime: v.event.event_time,
      ingestTime,
      sourceId: v.event.source_id,
      sourceType: v.event.source_type,
      severity: v.event.severity,
      category: v.event.category,
      message: v.event.message,
      attributesJson: JSON.stringify(v.event.attributes ?? {}),
      correlationId: v.event.correlation_id ?? null,
      traceId: v.event.trace_id ?? null,
      actor: v.event.actor ?? null,
      origin,
      status: 'VALIDATED',
    }))
    try {
      await db.event.createMany({ data: rows })
      for (const v of valid) storedIds.push(v.event.event_id)
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err
      // unique-constraint race: retry per-row, classifying each outcome
      const storedSet = new Set<string>()
      for (let i = 0; i < valid.length; i++) {
        try {
          await db.event.create({ data: rows[i] })
          storedSet.add(valid[i].event.event_id)
        } catch (e2) {
          if ((e2 as { code?: string }).code === 'P2002') {
            result.duplicates += 1
            result.duplicateIds.push(valid[i].event.event_id)
          } else {
            throw e2
          }
        }
      }
      for (const v of valid) if (storedSet.has(v.event.event_id)) storedIds.push(v.event.event_id)
    }
    const storedIdSet = new Set(storedIds)
    storedRows = valid
      .filter((v) => storedIdSet.has(v.event.event_id))
      .map((v) => toStored({
        id: v.event.event_id,
        eventTime: v.event.event_time,
        sourceId: v.event.source_id,
        sourceType: v.event.source_type,
        severity: v.event.severity,
        category: v.event.category,
        message: v.event.message,
        attributesJson: JSON.stringify(v.event.attributes ?? {}),
        actor: v.event.actor ?? null,
      }))
    result.accepted = storedRows.length
    result.eventIds = storedRows.map((e) => e.id)
  }

  // 4) rule evaluation -> detections -> correlation -> incidents
  const outcomes: CorrelateOutcome[] = []
  if (storedRows.length > 0) {
    const detections = await evaluateRulesForEvents(storedRows, ctx)
    for (const det of detections) {
      if (det.status !== 'ACTIVE') continue
      const outcome = await correlateDetection(det, ctx)
      outcomes.push(outcome)
      result.detections.push(det)
    }
  }

  // 5) SG-RULE-007 (internal): validation failures within 60 s
  if (result.rejected > 0) {
    const det7 = await checkValidationFailures(ctx)
    if (det7 && det7.status === 'ACTIVE') {
      const outcome = await correlateDetection(det7, ctx)
      outcomes.push(outcome)
      result.detections.push(det7)
    }
  }
  result.incidents = outcomes

  // 6) mark events PROCESSED with measured latency
  if (storedRows.length > 0) {
    const latencyMs = opts.historicalLatency
      ? 4 + (Math.abs(ingestTime.getTime()) % 40) // seed replay: plausible 4..43 ms (documented demo data)
      : Math.max(0, Date.now() - ingestTime.getTime())
    await db.event.updateMany({
      where: { id: { in: storedRows.map((e) => e.id) } },
      data: { status: 'PROCESSED', latencyMs },
    })
    result.processed = storedRows.length
  }

  // 7) notifications (event:new batched 400 ms by notify module)
  if (doNotify && storedRows.length > 0) {
    queueEventNotifications(
      storedRows.map((e) => compactEvent({
        id: e.id, eventTime: e.eventTime, severity: e.severity, category: e.category,
        sourceId: e.sourceId, actor: e.actor, message: e.message, origin,
      })),
    )
    markLastEvent(Date.now())
  }
  if (doNotify) {
    for (const det of result.detections) void notify('detection:new', det.serialized)
    for (const outcome of outcomes) void notify(outcome.created ? 'incident:new' : 'incident:update', outcome.incident)
  }
  if (result.duplicates > 0) countDuplicates(result.duplicates)

  // 8) automatic retention check (at most every 5 min, triggered by ingest)
  if (doNotify) maybeRunRetention()

  return result
}

/** CONTRACT ingest response shape. */
export function ingestResponse(result: IngestResult): {
  accepted: number
  duplicates: number
  rejected: number
  eventIds: string[]
  duplicateIds: string[]
  rejectedItems: Array<{ index: number; reason: string }>
} {
  return {
    accepted: result.accepted,
    duplicates: result.duplicates,
    rejected: result.rejected,
    eventIds: result.eventIds,
    duplicateIds: result.duplicateIds,
    rejectedItems: result.rejectedItems,
  }
}
