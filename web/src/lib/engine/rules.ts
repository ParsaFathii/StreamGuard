// StreamGuard — detection rule engine (SG-RULE-001..007).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Semantics (documented, single source of truth for the demo edition):
// - Selector matching is a conjunction of its parts; for ratio rules the
//   severity list and attribute are ALTERNATIVES (numerator definition).
// - SG-RULE-006 matches (source_type in selector.sourceTypes) OR (source_id
//   starts with selector.sourceIdPrefix) when both are present.
// - Cooldown: a fire within cooldownSeconds of the last ACTIVE detection for
//   the same (rule, correlation value) creates a SUPPRESSED row instead
//   (suppression becomes observable and durable; no duplicate ACTIVE detection,
//   no incident correlation for suppressed fires).
// - Rule evaluation windows are queried relative to the TRIGGERING event's
//   event_time (works for live traffic and for historical replay in seeding).
import { db } from '@/lib/db'
import { attrValue, toStored, type EngineCtx, type StoredEvent } from '@/lib/engine/types'
import { SOURCE_REGISTRY } from '@/lib/engine/simulator'

export interface ParsedSelector {
  category?: string
  severity?: string[]
  sourceIdPrefix?: string
  sourceTypes?: string[]
  attribute?: { key: string; value: string }
  correlationKey?: 'actor' | 'source_id' | 'global'
  internal?: 'validation_failures'
  sequence?: Array<{ key: string; value: string; count: number }>
  minDenominator?: number
  comparison?: 'gte' | 'gt'
}

export interface RuleDef {
  id: string
  name: string
  enabled: boolean
  selector: ParsedSelector
  conditionType: 'count' | 'ratio' | 'sequence' | 'exists'
  threshold: number
  windowSeconds: number
  severity: string
  cooldownSeconds: number
  suppression: boolean
}

export function parseRuleRow(row: {
  id: string; name: string; enabled: boolean; selectorJson: string; conditionType: string
  threshold: number; windowSeconds: number; severity: string; cooldownSeconds: number; suppression: boolean
}): RuleDef {
  let selector: ParsedSelector = {}
  try {
    selector = JSON.parse(row.selectorJson) as ParsedSelector
  } catch {
    selector = {}
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    selector,
    conditionType: row.conditionType as RuleDef['conditionType'],
    threshold: row.threshold,
    windowSeconds: row.windowSeconds,
    severity: row.severity,
    cooldownSeconds: row.cooldownSeconds,
    suppression: row.suppression,
  }
}

export async function loadRuleDefs(onlyEnabled = true): Promise<RuleDef[]> {
  const rows = await db.rule.findMany()
  return rows.map(parseRuleRow).filter((r) => (onlyEnabled ? r.enabled : true))
}

// ---------- pure matching core (shared by live engine and ML evaluation) ----------

function severityInList(ev: StoredEvent, list?: string[]): boolean {
  if (!list || list.length === 0) return true
  return list.includes(ev.severity)
}

function sourceConstraintOk(ev: StoredEvent, s: ParsedSelector): boolean {
  const hasTypes = !!s.sourceTypes && s.sourceTypes.length > 0
  const hasPrefix = !!s.sourceIdPrefix
  if (!hasTypes && !hasPrefix) return true
  const byType = hasTypes && (s.sourceTypes as string[]).includes(ev.sourceType)
  const byPrefix = hasPrefix && ev.sourceId.startsWith(s.sourceIdPrefix as string)
  if (hasTypes && hasPrefix) return byType || byPrefix // SG-RULE-006 semantics
  return byType ?? byPrefix ?? true
}

function attributeOk(ev: StoredEvent, s: ParsedSelector): boolean {
  if (!s.attribute) return true
  return attrValue(ev.attributes, s.attribute.key) === s.attribute.value
}

/** Full selector match (count/exists rules and sequence candidates). */
export function matchSelector(rule: RuleDef, ev: StoredEvent): boolean {
  const s = rule.selector
  if (s.category && ev.category !== s.category) return false
  if (!sourceConstraintOk(ev, s)) return false
  if (!attributeOk(ev, s)) return false
  if (s.severity && rule.conditionType !== 'ratio' && !severityInList(ev, s.severity)) return false
  return true
}

/** Numerator match for ratio rules: category AND (severity-list OR attribute). */
export function numeratorMatch(rule: RuleDef, ev: StoredEvent): boolean {
  const s = rule.selector
  if (s.category && ev.category !== s.category) return false
  if (!sourceConstraintOk(ev, s)) return false
  const bySev = s.severity ? s.severity.includes(ev.severity) : false
  const byAttr = attributeOk(ev, s)
  return bySev || byAttr
}

export function isCandidate(rule: RuleDef, ev: StoredEvent): boolean {
  if (rule.conditionType === 'sequence') {
    const seq = rule.selector.sequence
    if (!seq || seq.length === 0) return false
    if (!matchSelector(rule, ev)) return false
    const last = seq[seq.length - 1]
    return attrValue(ev.attributes, last.key) === last.value
  }
  return matchSelector(rule, ev)
}

export function correlationValue(rule: RuleDef, ev: StoredEvent): string {
  const key = rule.selector.correlationKey ?? 'source_id'
  if (key === 'actor') return ev.actor ?? ev.sourceId // documented fallback for actor-less events
  if (key === 'global') return 'global'
  return ev.sourceId
}

export interface FireResult {
  fire: boolean
  matchedCount: number
  score: number
  sampleEventIds: string[]
  extras?: Record<string, unknown>
}

function clampScore(v: number): number {
  return Math.min(1, Math.max(0.15, Math.round(v * 1000) / 1000))
}

function compareHit(actual: number, threshold: number, comparison: 'gte' | 'gt' | undefined): boolean {
  return comparison === 'gt' ? actual > threshold : actual >= threshold
}

/**
 * Pure evaluation of one trigger candidate.
 * @param window events of the SAME correlation subject within [ev.eventTime - window, ev.eventTime]
 * (any category — ratio denominators need the full population).
 */
export function evaluateTrigger(rule: RuleDef, ev: StoredEvent, window: StoredEvent[]): FireResult {
  const empty: FireResult = { fire: false, matchedCount: 0, score: 0, sampleEventIds: [] }
  if (rule.conditionType === 'count') {
    const matched = window.filter((w) => matchSelector(rule, w))
    const hit = compareHit(matched.length, rule.threshold, rule.selector.comparison)
    return {
      fire: hit,
      matchedCount: matched.length,
      score: clampScore(matched.length / (2 * rule.threshold)),
      sampleEventIds: matched.slice(-10).map((m) => m.id),
      extras: { subjectCount: matched.length },
    }
  }
  if (rule.conditionType === 'ratio') {
    const numerator = window.filter((w) => numeratorMatch(rule, w))
    const denominator = window.length
    const minDen = rule.selector.minDenominator ?? 20
    if (denominator < minDen) return empty
    const ratio = numerator.length / denominator
    const hit = compareHit(ratio, rule.threshold, rule.selector.comparison)
    return {
      fire: hit,
      matchedCount: numerator.length,
      score: clampScore(ratio / (2 * rule.threshold)),
      sampleEventIds: numerator.slice(-10).map((m) => m.id),
      extras: { ratio: Math.round(ratio * 1000) / 1000, denominator, numeratorCount: numerator.length },
    }
  }
  if (rule.conditionType === 'sequence') {
    const seq = rule.selector.sequence
    if (!seq || seq.length < 2) return empty
    const first = seq[0]
    const fails = window.filter((w) => attrValue(w.attributes, first.key) === first.value)
    const hit = fails.length >= first.count
    return {
      fire: hit,
      matchedCount: fails.length,
      score: clampScore(fails.length / (2 * first.count)),
      sampleEventIds: fails.slice(-10).map((m) => m.id),
      extras: { pattern: `${first.key}=${first.value} x${first.count} then ${seq[seq.length - 1].key}=${seq[seq.length - 1].value}` },
    }
  }
  // exists
  return { fire: true, matchedCount: 1, score: 0.85, sampleEventIds: [ev.id], extras: {} }
}

// ---------- detection creation ----------

export interface CreatedDetection {
  id: string
  ruleId: string
  ruleName: string
  ruleSeverity: string
  cv: string
  ckey: string
  trigger: StoredEvent | null
  attachEventIds: string[]
  status: 'ACTIVE' | 'SUPPRESSED'
  serialized: Record<string, unknown>
}

function detectionDetail(rule: RuleDef, ev: StoredEvent | null, cv: string, res: FireResult): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    matchedCount: res.matchedCount,
    windowSeconds: rule.windowSeconds,
    cv,
    ckey: rule.selector.correlationKey ?? 'source_id',
    sourceId: ev ? ev.sourceId : 'ingest',
    sampleEventIds: res.sampleEventIds,
    ...(res.extras ?? {}),
  }
  if (ev && rule.selector.correlationKey === 'actor') detail.actor = cv
  return detail
}

async function inCooldown(rule: RuleDef, cv: string, ctx: EngineCtx): Promise<boolean> {
  if (rule.cooldownSeconds <= 0) return false
  const since = new Date(ctx.now.getTime() - rule.cooldownSeconds * 1000)
  const recent = await db.detection.findMany({
    where: { ruleId: rule.id, status: 'ACTIVE', createdAt: { gte: since } },
    select: { detailJson: true },
    take: 100,
  })
  return recent.some((d) => {
    try {
      return (JSON.parse(d.detailJson) as { cv?: string }).cv === cv
    } catch {
      return false
    }
  })
}

async function createDetectionRow(
  rule: RuleDef,
  ev: StoredEvent | null,
  cv: string,
  res: FireResult,
  status: 'ACTIVE' | 'SUPPRESSED',
  ctx: EngineCtx,
): Promise<CreatedDetection> {
  const title = `${rule.name} — ${cv}`
  const detail = detectionDetail(rule, ev, cv, res)
  const row = await db.detection.create({
    data: {
      ruleId: rule.id,
      eventId: ev ? ev.id : 'internal:validation',
      severity: rule.severity,
      score: res.score,
      title,
      detailJson: JSON.stringify(detail),
      status,
      createdAt: ctx.now,
    },
  })
  const attachEventIds = Array.from(new Set([...res.sampleEventIds, ...(ev ? [ev.id] : [])]))
  return {
    id: row.id,
    ruleId: rule.id,
    ruleName: rule.name,
    ruleSeverity: rule.severity,
    cv,
    ckey: rule.selector.correlationKey ?? 'source_id',
    trigger: ev,
    attachEventIds,
    status,
    serialized: {
      id: row.id,
      ruleId: rule.id,
      eventId: row.eventId,
      incidentId: null,
      severity: row.severity,
      score: row.score,
      title: row.title,
      detail,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    },
  }
}

// ---------- live evaluation over a batch of newly stored events ----------

export async function evaluateRulesForEvents(events: StoredEvent[], ctx: EngineCtx): Promise<CreatedDetection[]> {
  const rules = await loadRuleDefs()
  const out: CreatedDetection[] = []
  const sorted = [...events].sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
  for (const rule of rules) {
    if (rule.selector.internal) continue // SG-RULE-007 handled separately
    const candidates = sorted.filter((e) => isCandidate(rule, e))
    if (candidates.length === 0) continue
    // group candidates by correlation subject
    const groups = new Map<string, StoredEvent[]>()
    for (const c of candidates) {
      const cv = correlationValue(rule, c)
      const arr = groups.get(cv) ?? []
      arr.push(c)
      groups.set(cv, arr)
    }
    for (const [cv, cands] of groups) {
      const minT = new Date(cands[0].eventTime.getTime() - rule.windowSeconds * 1000)
      const maxT = cands[cands.length - 1].eventTime
      const subjectWhere =
        (rule.selector.correlationKey ?? 'source_id') === 'actor' ? { actor: cv } : { sourceId: cv }
      const rows = await db.event.findMany({
        where: { ...subjectWhere, eventTime: { gte: minT, lte: maxT } },
        take: 500, // bounded window population
      })
      const pool = rows.map(toStored).sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
      for (const cand of cands) {
        const winStart = cand.eventTime.getTime() - rule.windowSeconds * 1000
        const window = pool.filter((p) => p.eventTime.getTime() >= winStart && p.eventTime.getTime() <= cand.eventTime.getTime())
        const res = evaluateTrigger(rule, cand, window)
        if (!res.fire) continue
        const suppressed = await inCooldown(rule, cv, ctx)
        const det = await createDetectionRow(rule, cand, cv, res, suppressed ? 'SUPPRESSED' : 'ACTIVE', ctx)
        out.push(det)
      }
    }
  }
  return out
}

// ---------- SG-RULE-007: ingestion validation failures (internal) ----------

export async function checkValidationFailures(ctx: EngineCtx): Promise<CreatedDetection | null> {
  const rules = await loadRuleDefs()
  const rule = rules.find((r) => r.selector.internal === 'validation_failures')
  if (!rule) return null
  const windowSeconds = rule.windowSeconds
  const since = new Date(ctx.now.getTime() - windowSeconds * 1000)
  const count = await db.validationFailure.count({ where: { ts: { gte: since, lte: ctx.now } } })
  if (count < rule.threshold) return null
  if (await inCooldown(rule, 'global', ctx)) {
    return createDetectionRow(
      rule, null, 'global',
      { fire: true, matchedCount: count, score: Math.min(1, count / (2 * rule.threshold)), sampleEventIds: [] },
      'SUPPRESSED', ctx,
    )
  }
  const latest = await db.validationFailure.findFirst({ where: { ts: { gte: since, lte: ctx.now } }, orderBy: { ts: 'desc' } })
  const det = await createDetectionRow(
    rule, null, 'global',
    { fire: true, matchedCount: count, score: Math.min(1, count / (2 * rule.threshold)), sampleEventIds: [] },
    'ACTIVE', ctx,
  )
  if (latest) {
    await db.detection.update({ where: { id: det.id }, data: { eventId: `vf:${latest.id}` } })
    det.serialized.eventId = `vf:${latest.id}`
  }
  return det
}

// ---------- pure rules pass for ML evaluation (in-memory, no DB writes) ----------

export interface PureFire {
  ruleId: string
  trigger: StoredEvent
  cv: string
}

export function runRulesPure(events: StoredEvent[], rules: RuleDef[]): PureFire[] {
  const sorted = [...events].sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
  const fires: PureFire[] = []
  const lastFire = new Map<string, number>() // `${ruleId}|${cv}` -> fire ts (ms)
  for (const rule of rules) {
    if (rule.selector.internal) continue
    const candidates = sorted.filter((e) => isCandidate(rule, e))
    const groups = new Map<string, StoredEvent[]>()
    for (const c of candidates) {
      const cv = correlationValue(rule, c)
      const arr = groups.get(cv) ?? []
      arr.push(c)
      groups.set(cv, arr)
    }
    for (const [cv, cands] of groups) {
      for (const cand of cands) {
        const winStart = cand.eventTime.getTime() - rule.windowSeconds * 1000
        const window = sorted.filter(
          (p) => {
            if (rule.selector.correlationKey === 'actor' ? p.actor !== cv : p.sourceId !== cv) return false
            return p.eventTime.getTime() >= winStart && p.eventTime.getTime() <= cand.eventTime.getTime()
          },
        )
        const res = evaluateTrigger(rule, cand, window)
        if (!res.fire) continue
        const key = `${rule.id}|${cv}`
        const prev = lastFire.get(key)
        if (prev !== undefined && cand.eventTime.getTime() - prev < rule.cooldownSeconds * 1000) continue // suppressed
        lastFire.set(key, cand.eventTime.getTime())
        fires.push({ ruleId: rule.id, trigger: cand, cv })
      }
    }
  }
  return fires
}

// source display metadata (shared with /api/sources)
export function sourceMeta(sourceId: string): { type: string; name: string; description: string } {
  return SOURCE_REGISTRY[sourceId] ?? { type: 'app', name: sourceId, description: `Simulator source ${sourceId}` }
}
