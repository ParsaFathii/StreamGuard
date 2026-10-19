// StreamGuard — strict event schema validation (schema_version = 1).
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { CATEGORIES, SEVERITIES, SOURCE_TYPES } from '@/lib/types'
import type { Category, Severity, SourceType } from '@/lib/types'

export const MAX_EVENT_BYTES = 4096 // single event limit
export const MAX_BODY_BYTES = 256 * 1024 // batch request body limit
export const FUTURE_SKEW_MS = 10 * 60 * 1000 // event_time may not be more than 10 min in the future

const SOURCE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/
const EVENT_FIELDS = [
  'event_id',
  'schema_version',
  'event_time',
  'source_id',
  'source_type',
  'severity',
  'category',
  'message',
  'attributes',
  'correlation_id',
  'trace_id',
  'actor',
] as const

export interface ValidatedEvent {
  event_id: string
  schema_version: 1
  event_time: Date
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

export type ValidationOutcome = { ok: true; event: ValidatedEvent } | { ok: false; reason: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length < 10) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d
}

export function validateEventInput(raw: unknown): ValidationOutcome {
  if (!isPlainObject(raw)) return { ok: false, reason: 'event must be a JSON object' }

  // unknown fields (strict schema — never silently discard)
  for (const key of Object.keys(raw)) {
    if (!EVENT_FIELDS.includes(key as (typeof EVENT_FIELDS)[number])) {
      return { ok: false, reason: `unknown field: ${key}` }
    }
  }

  if (typeof raw.event_id !== 'string' || raw.event_id.length < 1 || raw.event_id.length > 128) {
    return { ok: false, reason: 'invalid field: event_id (required string, 1..128 chars)' }
  }
  if (raw.schema_version !== 1) {
    return { ok: false, reason: `schema_version must be 1 (got ${JSON.stringify(raw.schema_version)})` }
  }
  const eventTime = parseIso(raw.event_time)
  if (!eventTime) return { ok: false, reason: 'invalid event_time (ISO-8601 required)' }
  if (eventTime.getTime() > Date.now() + FUTURE_SKEW_MS) {
    return { ok: false, reason: 'event_time too far in the future (>10 min skew allowed)' }
  }
  if (typeof raw.source_id !== 'string' || !SOURCE_ID_RE.test(raw.source_id)) {
    return { ok: false, reason: 'invalid source_id (1..64 chars, [a-zA-Z0-9._-])' }
  }
  if (!SOURCE_TYPES.includes(raw.source_type as SourceType)) {
    return { ok: false, reason: `invalid source_type (one of ${SOURCE_TYPES.join('|')})` }
  }
  if (!SEVERITIES.includes(raw.severity as Severity)) {
    return { ok: false, reason: `invalid severity (one of ${SEVERITIES.join('|')})` }
  }
  if (!CATEGORIES.includes(raw.category as Category)) {
    return { ok: false, reason: `invalid category (one of ${CATEGORIES.join('|')})` }
  }
  if (typeof raw.message !== 'string' || raw.message.trim().length < 1 || raw.message.length > 512) {
    return { ok: false, reason: 'invalid message (1..512 chars)' }
  }

  let attributes: Record<string, unknown> | undefined
  if (raw.attributes !== undefined) {
    if (!isPlainObject(raw.attributes)) return { ok: false, reason: 'attributes must be a JSON object' }
    const size = JSON.stringify(raw.attributes).length
    if (size > MAX_EVENT_BYTES) return { ok: false, reason: 'attributes too large (stringified <= 4KB required)' }
    attributes = raw.attributes
  }
  for (const key of ['correlation_id', 'trace_id', 'actor'] as const) {
    const v = raw[key]
    if (v !== undefined) {
      if (typeof v !== 'string' || v.length < 1 || v.length > 128) {
        return { ok: false, reason: `invalid ${key} (string, 1..128 chars)` }
      }
    }
  }

  const total = JSON.stringify(raw).length
  if (total > MAX_EVENT_BYTES) return { ok: false, reason: `event exceeds 4KB limit (${total} bytes)` }

  return {
    ok: true,
    event: {
      event_id: raw.event_id,
      schema_version: 1,
      event_time: eventTime,
      source_id: raw.source_id,
      source_type: raw.source_type as SourceType,
      severity: raw.severity as Severity,
      category: raw.category as Category,
      message: raw.message,
      attributes,
      correlation_id: raw.correlation_id as string | undefined,
      trace_id: raw.trace_id as string | undefined,
      actor: raw.actor as string | undefined,
    },
  }
}

// best-effort source_id extraction for ValidationFailure rows (may be invalid itself)
export function extractSourceId(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null
  const sid = raw.source_id
  if (typeof sid === 'string' && SOURCE_ID_RE.test(sid)) return sid
  return null
}

export function truncateSample(raw: unknown, max = 256): string {
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (s === undefined) return ''
    return s.length <= max ? s : `${s.slice(0, max)}…`
  } catch {
    return '[unserializable]'
  }
}
