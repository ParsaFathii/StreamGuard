// StreamGuard — shared types (single source of truth for demo UI + API)
// Copyright © 2026 Parsa Fathi — Apache-2.0

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

export const CATEGORIES = ['auth', 'network', 'application', 'data', 'system', 'config', 'security'] as const
export type Category = (typeof CATEGORIES)[number]

export const SOURCE_TYPES = ['app', 'infra', 'system', 'security', 'synthetic'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export type Origin = 'synthetic' | 'external'
export type EventStatus = 'VALIDATED' | 'REJECTED' | 'PROCESSED'
export type Role = 'ADMIN' | 'ANALYST' | 'VIEWER'

export interface EventInput {
  event_id: string
  schema_version: number
  event_time: string
  source_id: string
  source_type: SourceType
  severity: Severity
  category: Category
  message: string
  attributes?: Record<string, unknown>
  correlation_id?: string
  trace_id?: string
  actor?: string
}

export interface SgEvent {
  id: string
  schemaVersion: number
  eventTime: string
  ingestTime: string
  sourceId: string
  sourceType: SourceType
  severity: Severity
  category: Category
  message: string
  attributes: Record<string, unknown>
  correlationId: string | null
  traceId: string | null
  actor: string | null
  origin: Origin
  status: EventStatus
  rejectionReason: string | null
  latencyMs: number | null
}

export interface RuleSelector {
  category?: Category
  severity?: Severity[]
  sourceIdPrefix?: string
  attribute?: { key: string; value: string }
}

export interface SgRule {
  id: string
  name: string
  description: string
  enabled: boolean
  selector: RuleSelector
  conditionType: 'count' | 'ratio' | 'sequence' | 'exists'
  threshold: number
  windowSeconds: number
  severity: Severity
  cooldownSeconds: number
  suppression: boolean
  version: number
  updatedAt: string
  fireCount24h?: number
  lastFiredAt?: string | null
}

export interface Detection {
  id: string
  ruleId: string
  eventId: string
  incidentId: string | null
  severity: Severity
  score: number
  title: string
  detail: {
    matchedCount: number
    windowSeconds: number
    actor?: string
    sourceId?: string
    sampleEventIds: string[]
  }
  status: 'ACTIVE' | 'SUPPRESSED'
  createdAt: string
}

export type IncidentStatus = 'NEW' | 'TRIAGED' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED'

export interface Incident {
  id: string
  title: string
  severity: Severity
  status: IncidentStatus
  ruleId: string
  correlationKey: string
  correlationLabel: string
  eventCount: number
  detectionCount: number
  firstEventTime: string | null
  lastEventTime: string | null
  assignedTo: string | null
  resolutionSummary: string | null
  createdAt: string
  updatedAt: string
}

export interface IncidentDetail extends Incident {
  events: Array<Pick<SgEvent, 'id' | 'eventTime' | 'severity' | 'category' | 'sourceId' | 'actor' | 'message' | 'correlationId'>>
  detections: Detection[]
  notes: Array<{ id: string; author: string; body: string; createdAt: string }>
  statusHistory: Array<{ fromStatus: string | null; toStatus: string; actor: string; note: string | null; ts: string }>
  aiReports: Array<{ id: string; ts: string; providerStatus: string }>
}

export interface Paginated<T> {
  data: T[]
  page: number
  pageSize: number
  total: number
}

export interface OverviewResponse {
  totals: {
    events24h: number
    events7d: number
    detections24h: number
    incidentsOpen: number
    incidents24h: number
    rejected24h: number
    duplicates24h: number
  }
  ingestRatePerMin: Array<{ minute: string; count: number }>
  severityBreakdown24h: Record<Severity, number>
  categoryBreakdown24h: Record<string, number>
  topSources24h: Array<{ sourceId: string; count: number }>
  processing: { avgLatencyMs24h: number; p95LatencyMs24h: number; lastProcessedAt: string | null }
  health: { db: 'up' | 'down'; ws: 'up' | 'down'; llm: 'ok' | 'disabled' | 'error'; queueDepth: number }
}

export interface MlAnomalyPoint {
  bucketStart: string
  rate: number
  errorRatio: number
  failedAuthRatio: number
  uniqueActors: number
  zscore: number
  iforestScore: number
  isAnomaly: boolean
}

export interface MlResponse {
  modelVersion: string
  method: string
  anomalyTimeline: MlAnomalyPoint[]
  currentBaselines: Array<{
    sourceId: string
    ewmaRate: number
    stddev: number
    currentRate: number
    zscore: number
    status: 'normal' | 'elevated' | 'anomalous'
  }>
  lastEvaluation: MlEvaluation | null
}

export interface MlEvaluation {
  ts: string
  datasetSize: number
  seed: number
  methods: {
    rules: MethodMetrics
    zscore: MethodMetrics
    iforest: MethodMetrics
  }
  datasetInfo: { label: string; anomalies: number; normal: number }
}

export interface MethodMetrics {
  precision: number
  recall: number
  f1: number
  fpr: number
  confusion: { tp: number; fp: number; tn: number; fn: number }
}

export interface AiReport {
  summary: string
  facts: string[]
  ruleFindings: string[]
  mlFindings: string[]
  hypotheses: string[]
  nextSteps: string[]
  references: { incidentId: string; eventIds: string[]; ruleIds: string[] }
}

export interface AiInvestigateResponse {
  report: AiReport
  provider: { name: string; model: string; status: 'ok' | 'error' | 'disabled' }
  durationMs: number
}

export interface AuditEntry {
  id: string
  ts: string
  actor: string
  role: string
  action: string
  targetType: string | null
  targetId: string | null
  details: Record<string, unknown>
}

export interface SgSettings {
  aiEnabled: boolean
  aiProvider: string
  correlationWindowSeconds: number
  retentionHours: number
  maxBatchSize: number
  rateLimitPerMin: number
  languageDefault: 'en' | 'fa'
}

export interface SourceInfo {
  id: string
  type: SourceType
  origin: Origin
  events24h: number
  lastEventAt: string | null
  status: 'active' | 'idle' | 'error'
}

export interface HealthResponse {
  status: 'ok' | 'degraded'
  version: string
  uptimeSec: number
  checks: { db: 'up' | 'down'; ws: 'up' | 'down'; llm: 'ok' | 'disabled' | 'error' }
  queue: { depth: number; processed24h: number; rejected24h: number }
  retention: { policy: string; lastRunAt: string | null; deletedCount: number }
}

export interface SessionUser {
  username: string
  role: Role
  displayName: string
}

export interface ScenarioInfo {
  id: string
  name: string
  description: string
  expectedDetections: string[]
  expectedIncidentSeverity: Severity | null
}

// Live stream channels (socket.io)
export type LiveChannels = 'event:new' | 'detection:new' | 'incident:new' | 'incident:update' | 'stats' | 'simulator'

export interface LiveEventPayload {
  id: string
  eventTime: string
  severity: Severity
  category: Category
  sourceId: string
  actor: string | null
  message: string
  origin: Origin
}
