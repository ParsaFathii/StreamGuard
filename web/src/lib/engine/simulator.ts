// StreamGuard — deterministic synthetic event simulator (demo edition).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Determinism: every generator uses a mulberry32 PRNG. Same (scenario, seed)
// produces the same semantic pattern (times, actors, counts, severities).
// event_id is a fresh UUID per run on purpose — it is the idempotency key and
// MUST differ across runs (a repeated id would be treated as a duplicate).
// All simulator data is labeled origin=synthetic server-side.
import crypto from 'node:crypto'
import type { Severity } from '@/lib/types'

export type RawEvent = Record<string, unknown>

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = () => number

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}
function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

export const SOURCE_REGISTRY: Record<string, { type: string; name: string; description: string }> = {
  'sim-app-01': { type: 'app', name: 'sim-app-01', description: 'Simulator application host (order services)' },
  'sim-app-02': { type: 'app', name: 'sim-app-02', description: 'Simulator application host (catalog services)' },
  'sim-api-gw': { type: 'app', name: 'sim-api-gw', description: 'Simulator API gateway (request routing)' },
  'sim-auth-svc': { type: 'security', name: 'sim-auth-svc', description: 'Simulator authentication service' },
  'prod-db-01': { type: 'infra', name: 'prod-db-01', description: 'Production database node (infra)' },
  'prod-web-02': { type: 'infra', name: 'prod-web-02', description: 'Production web tier (infra)' },
  'sim-infra-agent': { type: 'system', name: 'sim-infra-agent', description: 'Simulator infrastructure telemetry agent' },
  'sim-edge-01': { type: 'infra', name: 'sim-edge-01', description: 'Simulator edge cache node' },
}

const ACTORS = [
  'user_jdoe', 'user_amali', 'user_bnegar', 'user_ckian', 'user_dshirin',
  'service_deploy', 'svc_backup', 'svc_monitor', 'user_eliya', 'user_farhad',
] as const
const PATHS = ['/api/orders', '/api/catalog', '/api/checkout', '/api/users/me', '/api/search', '/api/cart', '/api/auth/refresh'] as const
const COMPONENTS = ['order-svc', 'catalog-svc', 'payment-svc', 'search-svc', 'notification-svc'] as const

interface EvSpec {
  time: Date
  source: string
  type: string
  sev: string
  cat: string
  msg: string
  attrs: Record<string, unknown>
  actor?: string
}

function ev(s: EvSpec): RawEvent {
  const out: RawEvent = {
    event_id: crypto.randomUUID(),
    schema_version: 1,
    event_time: s.time.toISOString(),
    source_id: s.source,
    source_type: s.type,
    severity: s.sev,
    category: s.cat,
    message: s.msg,
    attributes: s.attrs,
  }
  if (s.actor) out.actor = s.actor
  return out
}

function ipOf(rng: Rng): string {
  return `10.0.${int(rng, 2, 40)}.${int(rng, 2, 250)}`
}

/** One "normal operations" event chosen from weighted templates. */
function baselineEvent(rng: Rng, time: Date): RawEvent {
  const roll = rng()
  if (roll < 0.2) {
    const actor = pick(rng, ACTORS)
    return ev({
      time, source: 'sim-auth-svc', type: 'security', sev: 'info', cat: 'auth',
      msg: `Successful login for ${actor} (password)`, actor,
      attrs: { action: 'login_success', ip: ipOf(rng), method: 'password' },
    })
  }
  if (roll < 0.24) {
    const actor = pick(rng, ACTORS)
    return ev({
      time, source: 'sim-auth-svc', type: 'security', sev: 'medium', cat: 'auth',
      msg: `Failed login for ${actor} (incorrect password)`, actor,
      attrs: { action: 'login_failed', ip: ipOf(rng), method: 'password' },
    })
  }
  if (roll < 0.58) {
    const onGw = rng() < 0.7
    const source = onGw ? 'sim-api-gw' : 'sim-edge-01'
    const method = pick(rng, ['GET', 'GET', 'POST', 'PUT'])
    const path = pick(rng, PATHS)
    const lat = int(rng, onGw ? 14 : 8, onGw ? 240 : 120)
    return ev({
      time, source, type: onGw ? 'app' : 'infra', sev: 'info', cat: 'network',
      msg: `${method} ${path} 200 ${lat}ms`,
      attrs: { kind: 'request', method, path, status_code: 200, latency_ms: lat },
    })
  }
  if (roll < 0.8) {
    const source = pick(rng, ['sim-app-01', 'sim-app-02'])
    const comp = pick(rng, COMPONENTS)
    return ev({
      time, source, type: 'app', sev: rng() < 0.7 ? 'info' : 'low', cat: 'application',
      msg: `${comp}: batch sync completed (${int(rng, 40, 900)} records)`,
      attrs: { component: comp, records: int(rng, 40, 900) },
    })
  }
  if (roll < 0.89) {
    return ev({
      time, source: 'sim-infra-agent', type: 'system', sev: 'info', cat: 'system',
      msg: `agent heartbeat cpu=${int(rng, 9, 62)}% mem=${int(rng, 30, 78)}%`,
      attrs: { cpu_pct: int(rng, 9, 62), mem_pct: int(rng, 30, 78), kind: 'heartbeat' },
    })
  }
  if (roll < 0.93) {
    return ev({
      time, source: 'prod-db-01', type: 'infra', sev: 'low', cat: 'data',
      msg: `Slow query detected (${int(rng, 900, 2100)}ms) on orders table`,
      attrs: { kind: 'query', duration_ms: int(rng, 900, 2100), table: 'orders' },
    })
  }
  if (roll < 0.97) {
    const comp = pick(rng, COMPONENTS)
    return ev({
      time, source: pick(rng, ['sim-app-01', 'sim-app-02']), type: 'app', sev: 'low', cat: 'application',
      msg: `${comp}: retryable warning, backpressure on queue (depth ${int(rng, 20, 400)})`,
      attrs: { component: comp, error: false, queue_depth: int(rng, 20, 400) },
    })
  }
  const comp = pick(rng, COMPONENTS)
  return ev({
    time, source: 'sim-app-01', type: 'app', sev: 'medium', cat: 'application',
    msg: `${comp}: transient error, request retried automatically`,
    attrs: { component: comp, error: true, exception: 'TimeoutException', retried: true },
  })
}

/** Baseline batch: `count` events spread over `spreadSec` ending at `end` (ascending). */
export function generateBaseline(rng: Rng, end: Date, count: number, spreadSec = 150): RawEvent[] {
  const endMs = end.getTime()
  const times: number[] = []
  for (let i = 0; i < count; i++) times.push(endMs - Math.floor(rng() * spreadSec * 1000))
  times.sort((a, b) => a - b)
  const out: RawEvent[] = []
  for (const t of times) out.push(baselineEvent(rng, new Date(t)))
  return out
}

export interface ScenarioSpec {
  id: string
  name: string
  description: string
  expectedDetections: string[]
  expectedIncidentSeverity: Severity | null
  note?: string
  generate: (rng: Rng, end: Date) => RawEvent[]
}

const scenarioBruteForce = (rng: Rng, end: Date): RawEvent[] => {
  const out: RawEvent[] = []
  const t0 = end.getTime() - 80_000
  for (let i = 0; i < 8; i++) {
    out.push(ev({
      time: new Date(t0 + i * 8000), source: 'sim-auth-svc', type: 'security', sev: 'medium', cat: 'auth',
      msg: `Failed login for user_admin (attempt ${i + 1}/8, incorrect password)`, actor: 'user_admin',
      attrs: { action: 'login_failed', ip: ipOf(rng), method: 'password', attempt: i + 1 },
    }))
  }
  out.push(ev({
    time: new Date(end.getTime() - 4000), source: 'sim-auth-svc', type: 'security', sev: 'info', cat: 'auth',
    msg: 'Successful login for user_admin after repeated failures', actor: 'user_admin',
    attrs: { action: 'login_success', ip: ipOf(rng), method: 'password' },
  }))
  return out
}

const scenarioCredentialStuffing = (rng: Rng, end: Date): RawEvent[] => {
  const out: RawEvent[] = []
  const victims = ['user_pzia', 'user_mko', 'user_alt', 'svc_cron', 'user_nima', 'user_sara', 'user_tina', 'svc_gitbot']
  const t0 = end.getTime() - 120_000
  let k = 0
  const push = (actor: string, i: number) => {
    out.push(ev({
      time: new Date(t0 + k * 4200), source: 'sim-auth-svc', type: 'security', sev: 'medium', cat: 'auth',
      msg: `Failed login for ${actor} (password spray attempt)`, actor,
      attrs: { action: 'login_failed', ip: ipOf(rng), method: 'password', spray: true, attempt: i },
    }))
    k++
  }
  for (let i = 0; i < 6; i++) push('user_admin', i + 1)
  for (let i = 0; i < 6; i++) push('user_root', i + 1)
  for (const v of victims) { push(v, 1); push(v, 2) }
  return out
}

const scenarioTrafficBurst = (rng: Rng, end: Date): RawEvent[] => {
  const out: RawEvent[] = []
  const t0 = end.getTime() - 55_000
  for (let i = 0; i < 132; i++) {
    const method = pick(rng, ['GET', 'GET', 'POST'])
    const path = pick(rng, PATHS)
    const lat = int(rng, 12, 95)
    out.push(ev({
      time: new Date(t0 + Math.floor((i * 55_000) / 132)), source: 'sim-api-gw', type: 'app', sev: 'info', cat: 'network',
      msg: `${method} ${path} 200 ${lat}ms`,
      attrs: { kind: 'request', method, path, status_code: 200, latency_ms: lat, burst: true },
    }))
  }
  return out
}

const scenarioLatencySpike = (rng: Rng, end: Date): RawEvent[] => {
  const out: RawEvent[] = []
  const t0 = end.getTime() - 90_000
  for (let i = 0; i < 44; i++) {
    const lat = int(rng, 1500, 3800)
    out.push(ev({
      time: new Date(t0 + Math.floor((i * 90_000) / 44)), source: 'sim-edge-01', type: 'infra', sev: 'low', cat: 'network',
      msg: `GET /assets/app.js 200 ${lat}ms (upstream slow, cache miss)`,
      attrs: { kind: 'request', method: 'GET', path: '/assets/app.js', status_code: 200, latency_ms: lat, origin_cache: 'miss' },
    }))
  }
  return out
}

const scenarioErrorStorm = (rng: Rng, end: Date): RawEvent[] => {
  const out: RawEvent[] = []
  const t0 = end.getTime() - 240_000
  const exceptions = ['NullPointerException', 'SQLException: timeout', 'RedisTimeoutException', 'ObjectDisposedException']
  for (let i = 0; i < 26; i++) {
    const comp = pick(rng, COMPONENTS)
    out.push(ev({
      time: new Date(t0 + Math.floor((i * 240_000) / 32)), source: 'sim-app-01', type: 'app', sev: 'high', cat: 'application',
      msg: `Unhandled exception in ${comp}: ${pick(rng, exceptions)}`,
      attrs: { component: comp, error: true, exception: pick(rng, exceptions), storm: true },
    }))
  }
  for (let i = 0; i < 6; i++) {
    const comp = pick(rng, COMPONENTS)
    out.push(ev({
      time: new Date(t0 + 235_000 + i * 900), source: 'sim-app-01', type: 'app', sev: 'info', cat: 'application',
      msg: `${comp}: health check ok during degraded period`,
      attrs: { component: comp, error: false },
    }))
  }
  return out.sort((a, b) => String(a.event_time).localeCompare(String(b.event_time)))
}

const scenarioConfigChange = (rng: Rng, end: Date): RawEvent[] => {
  const offsets = [90_000, 60_000, 30_000]
  const targets = [
    { target: 'max_connections', from: '100', to: '400' },
    { target: 'shared_buffers', from: '128MB', to: '512MB' },
    { target: 'wal_level', from: 'replica', to: 'logical' },
  ]
  return offsets.map((off, i) => ev({
    time: new Date(end.getTime() - off), source: 'prod-db-01', type: 'infra', sev: 'high', cat: 'config',
    msg: `Configuration changed on prod-db-01: ${targets[i].target} ${targets[i].from} -> ${targets[i].to} by svc_deploy`,
    attrs: { action: 'change', target: targets[i].target, from: targets[i].from, to: targets[i].to, operator: 'svc_deploy' },
  }))
}

const scenarioAuthzFailures = (rng: Rng, end: Date): RawEvent[] => {
  const out: RawEvent[] = []
  const resources = ['/admin/api/settings', '/admin/api/users', '/internal/audit/export', '/admin/api/keys', '/admin/api/retention']
  for (let i = 0; i < 5; i++) {
    out.push(ev({
      time: new Date(end.getTime() - 70_000 + i * 14_000), source: 'sim-auth-svc', type: 'security', sev: 'medium', cat: 'security',
      msg: `Authorization denied for svc_monitor on ${resources[i % resources.length]} (missing role ADMIN)`, actor: 'svc_monitor',
      attrs: { action: 'access_denied', resource: resources[i % resources.length], required_role: 'ADMIN', principal: 'svc_monitor' },
    }))
  }
  return out
}

const scenarioMalformedBatch = (rng: Rng, end: Date): RawEvent[] => {
  // Intentionally invalid events exercising every rejection path.
  const t = (msAgo: number) => new Date(end.getTime() - msAgo).toISOString()
  const base = (over: RawEvent): RawEvent => ({
    event_id: crypto.randomUUID(),
    schema_version: 1,
    event_time: t(30_000),
    source_id: 'sim-app-02',
    source_type: 'app',
    severity: 'info',
    category: 'application',
    message: 'malformed-batch probe event',
    attributes: { probe: true },
    ...over,
  })
  const huge = 'x'.repeat(5 * 1024)
  const longMsg = 'y'.repeat(600)
  return [
    base({ severity: undefined as unknown as string }), // missing severity
    base({ severity: 'fatal' }), // bad enum
    base({ category: 'networking' }), // bad enum
    base({ event_time: '2026-13-45T99:99:99Z' }), // unparseable timestamp
    base({ event_time: new Date(end.getTime() + 20 * 60_000).toISOString() }), // >10 min future
    base({ source_id: 'bad source!' }), // charset violation
    base({ message: longMsg }), // >512 chars
    base({ schema_version: 2 }), // wrong schema
    base({ extra_field: 'nope' }), // unknown field
    base({ attributes: { blob: huge } }), // attributes >4KB
    base({ event_id: undefined as unknown as string }), // missing id
    base({ message: '' }), // empty message
  ]
}

const scenarioMixedAttack = (rng: Rng, end: Date): RawEvent[] => {
  const out: RawEvent[] = []
  const t0 = end.getTime() - 120_000
  for (let i = 0; i < 6; i++) {
    out.push(ev({
      time: new Date(t0 + i * 9000), source: 'sim-auth-svc', type: 'security', sev: 'medium', cat: 'auth',
      msg: `Failed login for user_admin (mixed-attack phase, attempt ${i + 1})`, actor: 'user_admin',
      attrs: { action: 'login_failed', ip: ipOf(rng), method: 'password', phase: 'mixed' },
    }))
  }
  out.push(ev({
    time: new Date(t0 + 70_000), source: 'sim-auth-svc', type: 'security', sev: 'info', cat: 'auth',
    msg: 'Successful login for user_admin after repeated failures', actor: 'user_admin',
    attrs: { action: 'login_success', ip: ipOf(rng), method: 'password', phase: 'mixed' },
  }))
  for (let i = 0; i < 126; i++) {
    const method = pick(rng, ['GET', 'POST'])
    const path = pick(rng, PATHS)
    const lat = int(rng, 10, 80)
    out.push(ev({
      time: new Date(end.getTime() - 70_000 + Math.floor((i * 55_000) / 126)), source: 'sim-api-gw', type: 'app', sev: 'info', cat: 'network',
      msg: `${method} ${path} 200 ${lat}ms`,
      attrs: { kind: 'request', method, path, status_code: 200, latency_ms: lat, phase: 'mixed' },
    }))
  }
  for (const off of [40_000, 20_000]) {
    out.push(ev({
      time: new Date(end.getTime() - off), source: 'prod-db-01', type: 'infra', sev: 'high', cat: 'config',
      msg: `Configuration changed on prod-db-01: autovacuum enabled -> disabled by svc_deploy`,
      attrs: { action: 'change', target: 'autovacuum', from: 'enabled', to: 'disabled', operator: 'svc_deploy', phase: 'mixed' },
    }))
  }
  for (const e of generateBaseline(rng, end, 10, 110)) out.push(e)
  return out.sort((a, b) => String(a.event_time).localeCompare(String(b.event_time)))
}

export const SCENARIOS: ScenarioSpec[] = [
  {
    id: 'clean_baseline', name: 'Clean Baseline', description: 'Normal operations across all simulator sources (auth, requests, app logs, heartbeats).',
    expectedDetections: [], expectedIncidentSeverity: null,
    note: 'No detections expected — healthy traffic.', generate: (rng, end) => generateBaseline(rng, end, 14, 150),
  },
  {
    id: 'brute_force', name: 'Brute Force', description: '8 failed logins for user_admin followed by a success — repeated auth failures + suspicious sequence.',
    expectedDetections: ['SG-RULE-001', 'SG-RULE-003'], expectedIncidentSeverity: 'high',
    note: 'Fires SG-RULE-001 (>=5 failures) and SG-RULE-003 (failures then success).', generate: scenarioBruteForce,
  },
  {
    id: 'credential_stuffing', name: 'Credential Stuffing', description: 'Password spray across many accounts; user_admin and user_root cross the per-actor threshold.',
    expectedDetections: ['SG-RULE-001'], expectedIncidentSeverity: 'high',
    note: 'SG-RULE-001 fires for the two accounts with >=5 failures; spray across other accounts stays below per-actor thresholds (ML sees the failed-auth ratio).', generate: scenarioCredentialStuffing,
  },
  {
    id: 'traffic_burst', name: 'Traffic Burst', description: '132 requests in ~55 s from sim-api-gw — abnormal request rate.',
    expectedDetections: ['SG-RULE-002'], expectedIncidentSeverity: 'medium', generate: scenarioTrafficBurst,
  },
  {
    id: 'latency_spike', name: 'Latency Spike', description: 'Edge cache requests with 1.5-3.8 s latency; volume stays below rate thresholds.',
    expectedDetections: [], expectedIncidentSeverity: null,
    note: 'No rule fires on latency alone — this is the ML/z-score showcase scenario.', generate: scenarioLatencySpike,
  },
  {
    id: 'error_storm', name: 'Error Storm', description: '26 application errors + 6 healthy events on sim-app-01 over 4 min — error ratio spike.',
    expectedDetections: ['SG-RULE-004'], expectedIncidentSeverity: 'medium', generate: scenarioErrorStorm,
  },
  {
    id: 'config_change', name: 'Unexpected Config Change', description: 'Three configuration changes on prod-db-01 (infra) — changes outside the change window.',
    expectedDetections: ['SG-RULE-006'], expectedIncidentSeverity: 'high', generate: scenarioConfigChange,
  },
  {
    id: 'authz_failures', name: 'Authorization Failures', description: 'svc_monitor denied on admin endpoints 5 times — repeated authorization failures.',
    expectedDetections: ['SG-RULE-005'], expectedIncidentSeverity: 'medium', generate: scenarioAuthzFailures,
  },
  {
    id: 'malformed_batch', name: 'Malformed Batch', description: '12 intentionally invalid events exercising every validation-rejection path.',
    expectedDetections: ['SG-RULE-007'], expectedIncidentSeverity: 'low',
    note: 'All events are rejected (ValidationFailure rows). SG-RULE-007 fires at >=10 rejections/60s (600 s cooldown; suppressed within cooldown).', generate: scenarioMalformedBatch,
  },
  {
    id: 'mixed_attack', name: 'Mixed Attack', description: 'Brute force + request burst + config changes interleaved — multi-rule compound incident.',
    expectedDetections: ['SG-RULE-001', 'SG-RULE-003', 'SG-RULE-002', 'SG-RULE-006'], expectedIncidentSeverity: 'high', generate: scenarioMixedAttack,
  },
]

export function getScenario(id: string): ScenarioSpec | undefined {
  return SCENARIOS.find((s) => s.id === id)
}

/** Normal-activity tick (POST /api/simulator/tick). */
export function generateTick(rng: Rng, end: Date, count: number): RawEvent[] {
  return generateBaseline(rng, end, count, 120)
}
