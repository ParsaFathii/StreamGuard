// StreamGuard — Prometheus text rendering for GET /api/metrics.
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Durable values come from DB aggregates; process-local counters cover what
// cannot be derived from the DB (duplicates, ingest HTTP codes, LLM calls) —
// those reset on restart (documented in the emitted comments).
import { db } from '@/lib/db'
import { procStats } from '@/lib/engine/proc-stats'
import { getRetentionState } from '@/lib/settings'

const STREAM_URL = 'http://127.0.0.1:3003'

async function wsConnections(): Promise<number> {
  try {
    const res = await fetch(`${STREAM_URL}/health`, { signal: AbortSignal.timeout(1000) })
    if (!res.ok) return 0
    const body = (await res.json()) as { connections?: number }
    return body.connections ?? 0
  } catch {
    return 0
  }
}

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[idx]
}

export async function renderPrometheus(): Promise<string> {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000)

  const [byOrigin, totalEvents, rejected, latencyRows, detectionsActive, detectionsSuppressed, incidentsByStatus, incidentsOpen, wsConn] =
    await Promise.all([
      db.event.groupBy({ by: ['origin'], _count: { _all: true } }),
      db.event.count(),
      db.validationFailure.count(),
      db.event.findMany({ where: { ingestTime: { gte: since24h }, latencyMs: { not: null } }, select: { latencyMs: true }, take: 5000 }),
      db.detection.groupBy({ by: ['ruleId'], where: { status: 'ACTIVE' }, _count: { _all: true } }),
      db.detection.groupBy({ by: ['ruleId'], where: { status: 'SUPPRESSED' }, _count: { _all: true } }),
      db.incident.groupBy({ by: ['status'], _count: { _all: true } }),
      db.incident.count({ where: { status: { in: ['NEW', 'TRIAGED', 'INVESTIGATING'] } } }),
      wsConnections(),
    ])

  const latencies = latencyRows.map((r) => r.latencyMs ?? 0).filter((v) => v >= 0)
  const avgLat = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0

  const lines: string[] = []
  const push = (s: string) => lines.push(s)

  push('# HELP streamguard_events_received_total Accepted (stored) events by data origin. Durable (DB).')
  push('# TYPE streamguard_events_received_total counter')
  for (const row of byOrigin) {
    push(`streamguard_events_received_total{origin="${row.origin}"} ${row._count._all}`)
  }
  if (byOrigin.length === 0) push('streamguard_events_received_total{origin="synthetic"} 0')
  push('# HELP streamguard_events_accepted_total Total accepted (stored) events. Durable (DB).')
  push('# TYPE streamguard_events_accepted_total counter')
  push(`streamguard_events_accepted_total ${totalEvents}`)
  push('# HELP streamguard_events_rejected_total Events rejected by schema validation. Durable (DB, ValidationFailure rows).')
  push('# TYPE streamguard_events_rejected_total counter')
  push(`streamguard_events_rejected_total ${rejected}`)
  push('# HELP streamguard_validation_failures_total Alias of rejected (ValidationFailure rows). Durable (DB).')
  push('# TYPE streamguard_validation_failures_total counter')
  push(`streamguard_validation_failures_total ${rejected}`)
  push('# HELP streamguard_events_duplicates_total Duplicate event_id ingest hits. Process-local (resets on restart).')
  push('# TYPE streamguard_events_duplicates_total counter')
  push(`streamguard_events_duplicates_total ${procStats.ingestDuplicates}`)
  push('# HELP streamguard_processing_latency_ms Ingest->processed latency over 24h, ms.')
  push('# TYPE streamguard_processing_latency_ms summary')
  push(`streamguard_processing_latency_ms{stat="avg"} ${avgLat}`)
  push(`streamguard_processing_latency_ms{stat="p95"} ${p95(latencies)}`)
  push('# HELP streamguard_detections_total Active detections by rule. Durable (DB).')
  push('# TYPE streamguard_detections_total counter')
  for (const row of detectionsActive) {
    push(`streamguard_detections_total{rule_id="${row.ruleId}"} ${row._count._all}`)
  }
  push('# HELP streamguard_detections_suppressed_total Fires suppressed by cooldown. Durable (DB).')
  push('# TYPE streamguard_detections_suppressed_total counter')
  for (const row of detectionsSuppressed) {
    push(`streamguard_detections_suppressed_total{rule_id="${row.ruleId}"} ${row._count._all}`)
  }
  push('# HELP streamguard_incidents_total Incidents by status. Durable (DB).')
  push('# TYPE streamguard_incidents_total counter')
  for (const row of incidentsByStatus) {
    push(`streamguard_incidents_total{status="${row.status}"} ${row._count._all}`)
  }
  push('# HELP streamguard_incidents_open Currently open incidents (NEW/TRIAGED/INVESTIGATING).')
  push('# TYPE streamguard_incidents_open gauge')
  push(`streamguard_incidents_open ${incidentsOpen}`)
  push('# HELP streamguard_ingest_requests_total Ingest HTTP requests by status code. Process-local (resets on restart).')
  push('# TYPE streamguard_ingest_requests_total counter')
  const codes = [...procStats.ingestByCode.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (codes.length === 0) push('streamguard_ingest_requests_total{code="202"} 0')
  for (const [code, n] of codes) push(`streamguard_ingest_requests_total{code="${code}"} ${n}`)
  push('# HELP streamguard_llm_requests_total AI investigation requests. Process-local (resets on restart).')
  push('# TYPE streamguard_llm_requests_total counter')
  push(`streamguard_llm_requests_total ${procStats.llmRequests}`)
  push('# HELP streamguard_llm_failures_total AI provider failures. Process-local (resets on restart).')
  push('# TYPE streamguard_llm_failures_total counter')
  push(`streamguard_llm_failures_total ${procStats.llmFailures}`)
  const retention = await getRetentionState()
  push('# HELP streamguard_retention_deleted_total Events deleted by retention sweeps (cumulative). Durable (settings state).')
  push('# TYPE streamguard_retention_deleted_total counter')
  push(`streamguard_retention_deleted_total ${retention.totalDeleted ?? 0}`)
  push('# HELP streamguard_ws_connections Live stream connections (from stream service /health).')
  push('# TYPE streamguard_ws_connections gauge')
  push(`streamguard_ws_connections ${wsConn}`)
  push('# HELP streamguard_queue_depth Embedded engine queue depth (always 0 — synchronous embedded processing).')
  push('# TYPE streamguard_queue_depth gauge')
  push('streamguard_queue_depth 0')
  push('# HELP streamguard_uptime_seconds API process uptime.')
  push('# TYPE streamguard_uptime_seconds gauge')
  push(`streamguard_uptime_seconds ${Math.floor(process.uptime())}`)

  return `${lines.join('\n')}\n`
}
