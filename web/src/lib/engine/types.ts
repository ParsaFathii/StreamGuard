// StreamGuard — shared engine types + small utilities.
// Copyright © 2026 Parsa Fathi — Apache-2.0
import type { Severity } from '@/lib/types'

export const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }

export function maxSeverity(a: string, b: string): string {
  return (SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a
}

export function severityWeight(s: string): number {
  // used as an ML feature: weighted average severity per bucket
  switch (s) {
    case 'info':
      return 0.2
    case 'low':
      return 0.4
    case 'medium':
      return 0.6
    case 'high':
      return 0.8
    case 'critical':
      return 1
    default:
      return 0.2
  }
}

/** In-memory representation of a stored Event row (attributes parsed). */
export interface StoredEvent {
  id: string
  eventTime: Date
  sourceId: string
  sourceType: string
  severity: string
  category: string
  message: string
  attributes: Record<string, unknown>
  actor: string | null
}

/** Processing context threaded through the engine (supports historical replay for seeding). */
export interface EngineCtx {
  now: Date
}

export function toStored(e: {
  id: string
  eventTime: Date
  sourceId: string
  sourceType: string
  severity: string
  category: string
  message: string
  attributesJson: string
  actor: string | null
}): StoredEvent {
  let attributes: Record<string, unknown> = {}
  try {
    attributes = e.attributesJson ? (JSON.parse(e.attributesJson) as Record<string, unknown>) : {}
  } catch {
    attributes = {}
  }
  return {
    id: e.id,
    eventTime: e.eventTime,
    sourceId: e.sourceId,
    sourceType: e.sourceType,
    severity: e.severity,
    category: e.category,
    message: e.message,
    attributes,
    actor: e.actor,
  }
}

export function attrValue(attributes: Record<string, unknown>, key: string): string | null {
  const v = attributes[key]
  if (v === undefined || v === null) return null
  if (typeof v === 'object') return null
  return String(v)
}
