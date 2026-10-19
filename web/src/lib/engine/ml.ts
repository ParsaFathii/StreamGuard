// StreamGuard — ML: EWMA z-score baselines + pure-TS Isolation Forest.
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Methods (deterministic, reproducible, honest — no fabricated numbers):
// - EWMA baseline: per source rate r_t; baseline = EWMA(alpha=0.3);
//   sigma-hat = EWMA of |dev|; anomaly if z > 3 (spikes only — negative z is
//   a quiet minute, not an anomaly).
// - Isolation Forest: modelVersion "iforest-ts-1.2.0", 100 trees, subsample 64,
//   max depth 8 (task-spec; ceil(log2(64))=6 is the classic value — 8 is used
//   here per build spec), anomaly if score > 0.61 (tunable, documented).
//   Features per minute-bucket per source:
//   [event_rate, error_ratio, failed_auth_ratio, unique_actors, avg_severity_weight]
// - Evaluation: labeled dataset from simulator scenarios (fixed seed 42),
//   methods compared (rules-only / zscore / iforest) with precision/recall/F1/
//   FPR + confusion computed from the actual run — real numbers only.
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { mulberry32, type Rng } from '@/lib/engine/simulator'
import { attrValue, severityWeight, type StoredEvent } from '@/lib/engine/types'
import { loadRuleDefs, runRulesPure } from '@/lib/engine/rules'
import type { MethodMetrics } from '@/lib/types'

export const MODEL_VERSION = 'iforest-ts-1.2.0'
export const IFOREST_SPEC = { trees: 100, subSample: 64, maxDepth: 8, threshold: 0.61 } as const
export const EWMA_SPEC = { alpha: 0.3, zThreshold: 3, sigmaFloor: 0.5 } as const

// ---------- features ----------

export interface BucketFeatures {
  rate: number
  errorRatio: number
  failedAuthRatio: number
  uniqueActors: number
  avgSeverityWeight: number
  count: number
}

export function isErrorEvent(e: StoredEvent): boolean {
  // same definition as the SG-RULE-004 numerator (documented shared semantics)
  if (e.category !== 'application') return false
  if (['medium', 'high', 'critical'].includes(e.severity)) return true
  return e.attributes?.error === true
}

export function isFailedAuth(e: StoredEvent): boolean {
  return e.category === 'auth' && attrValue(e.attributes, 'action') === 'login_failed'
}

export function aggregateFeatures(events: StoredEvent[]): BucketFeatures {
  const n = events.length
  if (n === 0) return { rate: 0, errorRatio: 0, failedAuthRatio: 0, uniqueActors: 0, avgSeverityWeight: 0, count: 0 }
  const errors = events.filter(isErrorEvent).length
  const failedAuth = events.filter(isFailedAuth).length
  const actors = new Set<string>()
  let sevSum = 0
  for (const e of events) {
    if (e.actor) actors.add(e.actor)
    sevSum += severityWeight(e.severity)
  }
  return {
    rate: n,
    errorRatio: Math.round((errors / n) * 1000) / 1000,
    failedAuthRatio: Math.round((failedAuth / n) * 1000) / 1000,
    uniqueActors: actors.size,
    avgSeverityWeight: Math.round((sevSum / n) * 1000) / 1000,
    count: n,
  }
}

export function featureVector(f: BucketFeatures): number[] {
  return [f.rate, f.errorRatio, f.failedAuthRatio, f.uniqueActors, f.avgSeverityWeight]
}

export function minuteFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000)
}

// ---------- EWMA z-score ----------

export interface EwmaPoint {
  baseline: number // EWMA after observing r_t
  sigma: number
  z: number // (r_t - baselineBefore) / max(sigma, floor)
}

export function ewmaSeries(rates: number[]): EwmaPoint[] {
  const out: EwmaPoint[] = []
  if (rates.length === 0) return out
  const a = EWMA_SPEC.alpha
  let baseline = rates[0]
  let sigma = EWMA_SPEC.sigmaFloor
  out.push({ baseline, sigma, z: 0 })
  for (let i = 1; i < rates.length; i++) {
    const r = rates[i]
    const dev = Math.abs(r - baseline)
    sigma = a * dev + (1 - a) * sigma
    const z = (r - baseline) / Math.max(sigma, EWMA_SPEC.sigmaFloor)
    baseline = a * r + (1 - a) * baseline
    out.push({ baseline, sigma: Math.max(sigma, EWMA_SPEC.sigmaFloor), z: Math.round(z * 100) / 100 })
  }
  return out
}

// ---------- Isolation Forest (pure TS, seeded) ----------

type IforestNode =
  | { leaf: true; size: number }
  | { leaf: false; feature: number; split: number; left: IforestNode; right: IforestNode }

export interface IforestModel {
  trees: IforestNode[]
  cSub: number
}

function harmonic(n: number): number {
  let s = 0
  for (let i = 1; i <= n; i++) s += 1 / i
  return s
}

export function cAdjust(n: number): number {
  if (n <= 1) return 0
  return 2 * harmonic(n - 1) - (2 * (n - 1)) / n
}

function buildTree(points: number[][], depth: number, rng: Rng, dims: number): IforestNode {
  if (depth >= IFOREST_SPEC.maxDepth || points.length <= 1) return { leaf: true, size: points.length }
  const f = Math.floor(rng() * dims)
  let min = Infinity
  let max = -Infinity
  for (const p of points) {
    if (p[f] < min) min = p[f]
    if (p[f] > max) max = p[f]
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return { leaf: true, size: points.length }
  const split = min + rng() * (max - min)
  const left: number[][] = []
  const right: number[][] = []
  for (const p of points) (p[f] < split ? left : right).push(p)
  if (left.length === 0 || right.length === 0) return { leaf: true, size: points.length }
  return {
    leaf: false,
    feature: f,
    split,
    left: buildTree(left, depth + 1, rng, dims),
    right: buildTree(right, depth + 1, rng, dims),
  }
}

function pathLength(node: IforestNode, x: number[], depth: number): number {
  if (node.leaf) return depth + (node.size > 1 ? cAdjust(node.size) : 0)
  return pathLength(x[node.feature] < node.split ? node.left : node.right, x, depth + 1)
}

export function trainIsolationForest(data: number[][], seed: number): IforestModel {
  const n = data.length
  if (n < 2) return { trees: [], cSub: 0 }
  const dims = data[0].length
  const subSize = Math.min(IFOREST_SPEC.subSample, n)
  const rng = mulberry32(seed)
  const indices = data.map((_, i) => i)
  const trees: IforestNode[] = []
  for (let t = 0; t < IFOREST_SPEC.trees; t++) {
    // partial Fisher-Yates: sample subSize indices without replacement
    const pool = indices.slice()
    for (let i = 0; i < subSize; i++) {
      const j = i + Math.floor(rng() * (pool.length - i))
      const tmp = pool[i]
      pool[i] = pool[j]
      pool[j] = tmp
    }
    const subsample: number[][] = []
    for (let i = 0; i < subSize; i++) subsample.push(data[pool[i]])
    trees.push(buildTree(subsample, 0, rng, dims))
  }
  return { trees, cSub: cAdjust(subSize) }
}

export function iforestScore(model: IforestModel, x: number[]): number {
  if (model.trees.length === 0 || model.cSub <= 0) return 0
  let sum = 0
  for (const tree of model.trees) sum += pathLength(tree, x, 0)
  const mean = sum / model.trees.length
  return Math.round(Math.pow(2, -mean / model.cSub) * 1000) / 1000
}

// ---------- live ML view (/api/analytics/ml) ----------

export interface MlAnomalyPointOut {
  bucketStart: string
  rate: number
  errorRatio: number
  failedAuthRatio: number
  uniqueActors: number
  zscore: number
  iforestScore: number
  isAnomaly: boolean
}

export interface MlBaselineOut {
  sourceId: string
  ewmaRate: number
  stddev: number
  currentRate: number
  zscore: number
  status: 'normal' | 'elevated' | 'anomalous'
}

export interface MlView {
  modelVersion: string
  method: string
  anomalyTimeline: MlAnomalyPointOut[]
  currentBaselines: MlBaselineOut[]
}

interface SampleBucket {
  sourceId: string
  minuteStart: Date
  features: BucketFeatures
}

function bucketKey(sourceId: string, minuteStart: Date): string {
  return `${sourceId}@${minuteStart.getTime()}`
}

function groupBuckets(events: StoredEvent[], minutes: number): Map<string, SampleBucket[]> {
  const since = new Date(Date.now() - minutes * 60_000)
  const bySource = new Map<string, Map<number, StoredEvent[]>>()
  for (const e of events) {
    if (e.eventTime < since) continue
    const m = minuteFloor(e.eventTime).getTime()
    let mm = bySource.get(e.sourceId)
    if (!mm) {
      mm = new Map()
      bySource.set(e.sourceId, mm)
    }
    const arr = mm.get(m) ?? []
    arr.push(e)
    mm.set(m, arr)
  }
  const result = new Map<string, SampleBucket[]>()
  for (const [sourceId, mm] of bySource) {
    const minutesList = [...mm.keys()].sort((a, b) => a - b)
    result.set(
      sourceId,
      minutesList.map((m) => ({
        sourceId,
        minuteStart: new Date(m),
        features: aggregateFeatures(mm.get(m) as StoredEvent[]),
      })),
    )
  }
  return result
}

export async function computeMlView(minutes = 120): Promise<MlView> {
  const since = new Date(Date.now() - minutes * 60_000)
  // select only the columns the feature builder reads (eventTime, sourceId,
  // category, severity, actor, attributes) — full rows would carry message +
  // metadata columns for up to 20k events per call
  const rows = await db.event.findMany({
    where: { eventTime: { gte: since } },
    select: { eventTime: true, sourceId: true, category: true, severity: true, actor: true, attributesJson: true },
    take: 20000,
  })
  const events: StoredEvent[] = rows.map((r) => {
    let attributes: Record<string, unknown> = {}
    try {
      attributes = r.attributesJson ? (JSON.parse(r.attributesJson) as Record<string, unknown>) : {}
    } catch {
      attributes = {}
    }
    return {
      id: '', // not read by the feature builder (StoredEvent shape placeholder)
      eventTime: r.eventTime,
      sourceId: r.sourceId,
      sourceType: '', // not read by the feature builder
      severity: r.severity,
      category: r.category,
      message: '', // not read by the feature builder
      attributes,
      actor: r.actor,
    }
  }).sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())

  // global per-minute timeline (zero-filled; idle minutes are not scored — documented)
  const firstMinute = minuteFloor(new Date(Date.now() - (minutes - 1) * 60_000)).getTime()
  const globalByMinute = new Map<number, StoredEvent[]>()
  for (const e of events) {
    const m = minuteFloor(e.eventTime).getTime()
    const arr = globalByMinute.get(m) ?? []
    arr.push(e)
    globalByMinute.set(m, arr)
  }
  const timeline: MlAnomalyPointOut[] = []
  const scoredFeatures: number[][] = []
  const ratesForEwma: number[] = []
  for (let i = 0; i < minutes; i++) {
    const m = firstMinute + i * 60_000
    const evs = globalByMinute.get(m) ?? []
    const f = aggregateFeatures(evs)
    ratesForEwma.push(f.rate)
    if (f.count > 0) scoredFeatures.push(featureVector(f))
  }
  const ewma = ewmaSeries(ratesForEwma)
  const iforest = scoredFeatures.length >= 10 ? trainIsolationForest(scoredFeatures, 42) : { trees: [], cSub: 0 }
  let featureIdx = 0
  for (let i = 0; i < minutes; i++) {
    const m = firstMinute + i * 60_000
    const evs = globalByMinute.get(m) ?? []
    const f = aggregateFeatures(evs)
    const z = f.count > 0 ? (ewma[i]?.z ?? 0) : 0
    const score = f.count > 0 && iforest.trees.length > 0 ? iforestScore(iforest, featureVector(f)) : 0
    if (f.count > 0) featureIdx++
    timeline.push({
      bucketStart: new Date(m).toISOString(),
      rate: f.rate,
      errorRatio: f.errorRatio,
      failedAuthRatio: f.failedAuthRatio,
      uniqueActors: f.uniqueActors,
      zscore: z,
      iforestScore: score,
      isAnomaly: f.count > 0 && (score > IFOREST_SPEC.threshold || z > EWMA_SPEC.zThreshold),
    })
  }

  // per-source baselines (minutes with data only — documented)
  const bySourceBuckets = groupBuckets(events, minutes)
  const baselines: MlBaselineOut[] = []
  for (const [sourceId, buckets] of bySourceBuckets) {
    if (buckets.length < 3) continue // not enough history for a meaningful baseline
    const rates = buckets.map((b) => b.features.rate)
    const series = ewmaSeries(rates)
    const last = series[series.length - 1]
    const currentRate = rates[rates.length - 1]
    const z = last?.z ?? 0
    const status: MlBaselineOut['status'] = z > EWMA_SPEC.zThreshold ? 'anomalous' : z >= 2 ? 'elevated' : 'normal'
    baselines.push({
      sourceId,
      ewmaRate: Math.round((last?.baseline ?? currentRate) * 100) / 100,
      stddev: Math.round((last?.sigma ?? EWMA_SPEC.sigmaFloor) * 100) / 100,
      currentRate,
      zscore: z,
      status,
    })
  }
  baselines.sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore))

  return { modelVersion: MODEL_VERSION, method: 'Isolation Forest + EWMA z-score', anomalyTimeline: timeline, currentBaselines: baselines }
}

// ---------- 5s TTL cache (HMR-safe, shared by /api/analytics/ml and /api/ai/investigate) ----------

interface MlViewCacheEntry {
  at: number
  minutes: number
  promise: Promise<MlView>
}
const mlCacheGlobal = globalThis as unknown as { __sgMlViewCache?: MlViewCacheEntry }
const ML_CACHE_TTL_MS = 5000

/** Cached ML view: recomputed at most every 5 s per process (both API callers share it). */
export function computeMlViewCached(minutes = 120): Promise<MlView> {
  const cached = mlCacheGlobal.__sgMlViewCache
  if (cached && cached.minutes === minutes && Date.now() - cached.at < ML_CACHE_TTL_MS) {
    return cached.promise
  }
  const promise = computeMlView(minutes)
  mlCacheGlobal.__sgMlViewCache = { at: Date.now(), minutes, promise }
  promise.catch(() => {
    // never serve a cached rejection
    if (mlCacheGlobal.__sgMlViewCache?.promise === promise) mlCacheGlobal.__sgMlViewCache = undefined
  })
  return promise
}

// ---------- latest stored evaluation ----------

export interface StoredEvaluation {
  ts: string
  datasetSize: number
  seed: number
  methods: { rules: MethodMetrics; zscore: MethodMetrics; iforest: MethodMetrics }
  datasetInfo: { label: string; anomalies: number; normal: number }
}

export async function getLatestEvaluation(): Promise<StoredEvaluation | null> {
  const row = await db.mlRun.findFirst({ where: { kind: 'EVALUATION' }, orderBy: { ts: 'desc' } })
  if (!row) return null
  try {
    const methods = JSON.parse(row.metricsJson) as StoredEvaluation['methods']
    const details = JSON.parse(row.detailsJson) as { datasetSize: number; datasetInfo: StoredEvaluation['datasetInfo'] }
    return {
      ts: row.ts.toISOString(),
      datasetSize: details.datasetSize,
      seed: row.seed,
      methods,
      datasetInfo: details.datasetInfo,
    }
  } catch {
    return null
  }
}

// ---------- labeled evaluation (deterministic, seed 42) ----------

interface DatasetEventSpec {
  time: Date
  source: string
  sourceType: string
  sev: string
  cat: string
  msg: string
  attrs: Record<string, unknown>
  actor?: string
}

function toEvalStored(s: DatasetEventSpec): StoredEvent {
  return {
    id: crypto.randomUUID(),
    eventTime: s.time,
    sourceId: s.source,
    sourceType: s.sourceType,
    severity: s.sev,
    category: s.cat,
    message: s.msg,
    attributes: s.attrs,
    actor: s.actor ?? null,
  }
}

function evalRng(seed: number, minute: number, sourceId: string): Rng {
  let h = 2166136261
  for (let i = 0; i < sourceId.length; i++) h = Math.imul(h ^ sourceId.charCodeAt(i), 16777619)
  return mulberry32((seed ^ Math.imul(minute + 1, 2654435761) ^ (h >>> 0)) >>> 0)
}

export interface EvaluationDataset {
  events: StoredEvent[]
  samples: Array<{ sourceId: string; minuteStart: Date; features: BucketFeatures; label: 0 | 1 }>
  anomalies: number
  normal: number
  labelDescription: string
}

/** Deterministic labeled dataset: 96 minutes, 5 sources, three attack windows. */
export function buildEvaluationDataset(seed = 42): EvaluationDataset {
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000
  const minuteStart = (m: number) => new Date(nowMinute - (95 - m) * 60_000)
  const sources = ['sim-auth-svc', 'sim-app-01', 'sim-api-gw', 'sim-edge-01', 'prod-db-01']
  const sourceType: Record<string, string> = {
    'sim-auth-svc': 'security', 'sim-app-01': 'app', 'sim-api-gw': 'app', 'sim-edge-01': 'infra', 'prod-db-01': 'infra',
  }
  const attackLabels = new Map<string, 0 | 1>()
  const events: StoredEvent[] = []

  const at = (m: number, rng: Rng) => new Date(minuteStart(m).getTime() + Math.floor(rng() * 59_000))

  for (let m = 0; m <= 95; m++) {
    // per-source baseline activity
    for (const src of sources) {
      const rng = evalRng(seed, m, src)
      const t0 = minuteStart(m).getTime()
      const mk = (sev: string, cat: string, msg: string, attrs: Record<string, unknown>, actor?: string, offMs?: number) =>
        events.push(toEvalStored({
          time: new Date(t0 + (offMs ?? Math.floor(rng() * 59_000))),
          source: src, sourceType: sourceType[src], sev, cat, msg, attrs, actor,
        }))
      if (src === 'sim-auth-svc') {
        const n = 1 + Math.floor(rng() * 3)
        for (let i = 0; i < n; i++) {
          const actor = ['user_jdoe', 'user_amali', 'user_bnegar', 'user_ckian'][Math.floor(rng() * 4)]
          mk('info', 'auth', `Successful login for ${actor} (password)`, { action: 'login_success', method: 'password' }, actor)
        }
        if (rng() < 0.12) mk('medium', 'auth', 'Failed login for user_jdoe (incorrect password)', { action: 'login_failed', method: 'password' }, 'user_jdoe')
      } else if (src === 'sim-api-gw') {
        const n = 2 + Math.floor(rng() * 3)
        for (let i = 0; i < n; i++) {
          const lat = 12 + Math.floor(rng() * 200)
          mk('info', 'network', `GET /api/orders 200 ${lat}ms`, { kind: 'request', method: 'GET', path: '/api/orders', status_code: 200, latency_ms: lat })
        }
      } else if (src === 'sim-app-01') {
        const n = 1 + Math.floor(rng() * 3)
        for (let i = 0; i < n; i++) {
          mk(rng() < 0.8 ? 'info' : 'low', 'application', 'order-svc: batch sync completed', { component: 'order-svc' })
        }
        if (rng() < 0.05) mk('medium', 'application', 'order-svc: transient error, retried', { component: 'order-svc', error: true, exception: 'TimeoutException' })
      } else if (src === 'sim-edge-01') {
        const n = 1 + Math.floor(rng() * 2)
        for (let i = 0; i < n; i++) {
          const lat = 8 + Math.floor(rng() * 110)
          mk('info', 'network', `GET /assets/app.js 200 ${lat}ms`, { kind: 'request', method: 'GET', path: '/assets/app.js', status_code: 200, latency_ms: lat })
        }
      } else if (src === 'prod-db-01') {
        if (rng() < 0.6) mk('low', 'data', 'Slow query detected (1240ms) on orders table', { kind: 'query', duration_ms: 1240, table: 'orders' })
      }
    }
    // attack window 1: brute force on sim-auth-svc, minutes 30..33
    if (m >= 30 && m <= 33) {
      const rng = evalRng(seed ^ 0x5f5f, m, 'sim-auth-svc-attack')
      for (let i = 0; i < 6; i++) {
        events.push(toEvalStored({
          time: new Date(minuteStart(m).getTime() + Math.floor(rng() * 59_000)),
          source: 'sim-auth-svc', sourceType: 'security', sev: 'medium', cat: 'auth',
          msg: `Failed login for user_admin (brute force attempt ${i + 1})`,
          attrs: { action: 'login_failed', method: 'password', attack: 'brute_force' }, actor: 'user_admin',
        }))
      }
      if (m === 33) {
        events.push(toEvalStored({
          time: new Date(minuteStart(m).getTime() + 59_500),
          source: 'sim-auth-svc', sourceType: 'security', sev: 'info', cat: 'auth',
          msg: 'Successful login for user_admin after repeated failures',
          attrs: { action: 'login_success', method: 'password', attack: 'brute_force' }, actor: 'user_admin',
        }))
      }
      attackLabels.set(`sim-auth-svc@${minuteStart(m).getTime()}`, 1)
    }
    // attack window 2: error storm on sim-app-01, minutes 55..58
    if (m >= 55 && m <= 58) {
      const rng = evalRng(seed ^ 0x6e6e, m, 'sim-app-01-attack')
      for (let i = 0; i < 8; i++) {
        events.push(toEvalStored({
          time: new Date(minuteStart(m).getTime() + Math.floor(rng() * 59_000)),
          source: 'sim-app-01', sourceType: 'app', sev: 'high', cat: 'application',
          msg: 'Unhandled exception in order-svc: NullPointerException',
          attrs: { component: 'order-svc', error: true, exception: 'NullPointerException', attack: 'error_storm' },
        }))
      }
      for (let i = 0; i < 2; i++) {
        events.push(toEvalStored({
          time: new Date(minuteStart(m).getTime() + Math.floor(rng() * 59_000)),
          source: 'sim-app-01', sourceType: 'app', sev: 'info', cat: 'application',
          msg: 'order-svc: health check ok during degraded period',
          attrs: { component: 'order-svc', error: false },
        }))
      }
      attackLabels.set(`sim-app-01@${minuteStart(m).getTime()}`, 1)
    }
    // attack window 3: traffic burst on sim-api-gw, minute 81
    if (m === 81) {
      const rng = evalRng(seed ^ 0x7d7d, m, 'sim-api-gw-attack')
      for (let i = 0; i < 130; i++) {
        const lat = 10 + Math.floor(rng() * 70)
        events.push(toEvalStored({
          time: new Date(minuteStart(m).getTime() + Math.floor((i * 55_000) / 130)),
          source: 'sim-api-gw', sourceType: 'app', sev: 'info', cat: 'network',
          msg: `POST /api/checkout 200 ${lat}ms`,
          attrs: { kind: 'request', method: 'POST', path: '/api/checkout', status_code: 200, latency_ms: lat, attack: 'traffic_burst' },
        }))
      }
      attackLabels.set(`sim-api-gw@${minuteStart(m).getTime()}`, 1)
    }
  }

  // build samples per (source, minute) with >= 1 event; label from attack windows
  const grouped = new Map<string, StoredEvent[]>()
  for (const e of events) {
    const key = bucketKey(e.sourceId, minuteFloor(e.eventTime))
    const arr = grouped.get(key) ?? []
    arr.push(e)
    grouped.set(key, arr)
  }
  const samples: EvaluationDataset['samples'] = []
  for (const [key, evs] of grouped) {
    const sourceId = key.split('@')[0]
    const minuteStart2 = new Date(Number(key.split('@')[1]))
    samples.push({
      sourceId,
      minuteStart: minuteStart2,
      features: aggregateFeatures(evs),
      label: attackLabels.get(key) ?? 0,
    })
  }
  samples.sort((a, b) => a.minuteStart.getTime() - b.minuteStart.getTime() || a.sourceId.localeCompare(b.sourceId))
  const anomalies = samples.filter((s) => s.label === 1).length
  return {
    events,
    samples,
    anomalies,
    normal: samples.length - anomalies,
    labelDescription:
      'Simulated 96-minute stream (5 sources, seed 42): brute-force on sim-auth-svc minutes 30-33, error-storm on sim-app-01 minutes 55-58, traffic burst on sim-api-gw minute 81; all other (source, minute) buckets labeled normal. Samples require >=1 event.',
  }
}

function computeMethodMetrics(
  samples: EvaluationDataset['samples'],
  predicted: Set<string>,
): MethodMetrics {
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (const s of samples) {
    const hit = predicted.has(bucketKey(s.sourceId, s.minuteStart))
    if (s.label === 1) {
      if (hit) tp++
      else fn++
    } else if (hit) fp++
    else tn++
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  return {
    precision: r4(precision),
    recall: r4(recall),
    f1: r4(f1),
    fpr: r4(fpr),
    confusion: { tp, fp, tn, fn },
  }
}

export async function runEvaluation(seed = 42): Promise<StoredEvaluation> {
  const dataset = buildEvaluationDataset(seed)

  // method 1: rules-only (real rule engine core, in-memory, current DB thresholds)
  const rules = (await loadRuleDefs()).filter((r) => !r.selector.internal)
  const fires = runRulesPure(dataset.events, rules)
  const rulesPred = new Set<string>()
  for (const f of fires) rulesPred.add(bucketKey(f.trigger.sourceId, minuteFloor(f.trigger.eventTime)))

  // method 2: per-source EWMA z-score on bucket rates
  const zscorePred = new Set<string>()
  {
    const bySource = new Map<string, EvaluationDataset['samples']>()
    for (const s of dataset.samples) {
      const arr = bySource.get(s.sourceId) ?? []
      arr.push(s)
      bySource.set(s.sourceId, arr)
    }
    for (const [, arr] of bySource) {
      const rates = arr.map((s) => s.features.rate)
      const series = ewmaSeries(rates)
      arr.forEach((s, i) => {
        if ((series[i]?.z ?? 0) > EWMA_SPEC.zThreshold) zscorePred.add(bucketKey(s.sourceId, s.minuteStart))
      })
    }
  }

  // method 3: Isolation Forest trained on all samples (unsupervised — labels not used)
  const iforestPred = new Set<string>()
  {
    const vectors = dataset.samples.map((s) => featureVector(s.features))
    const model = trainIsolationForest(vectors, seed)
    dataset.samples.forEach((s, i) => {
      if (iforestScore(model, vectors[i]) > IFOREST_SPEC.threshold) iforestPred.add(bucketKey(s.sourceId, s.minuteStart))
    })
  }

  const methods = {
    rules: computeMethodMetrics(dataset.samples, rulesPred),
    zscore: computeMethodMetrics(dataset.samples, zscorePred),
    iforest: computeMethodMetrics(dataset.samples, iforestPred),
  }
  const evaluation: StoredEvaluation = {
    ts: new Date().toISOString(),
    datasetSize: dataset.samples.length,
    seed,
    methods,
    datasetInfo: {
      label: dataset.labelDescription,
      anomalies: dataset.anomalies,
      normal: dataset.normal,
    },
  }
  await db.mlRun.create({
    data: {
      kind: 'EVALUATION',
      modelVersion: MODEL_VERSION,
      seed,
      metricsJson: JSON.stringify(methods),
      detailsJson: JSON.stringify({ datasetSize: evaluation.datasetSize, datasetInfo: evaluation.datasetInfo }),
    },
  })
  return evaluation
}
