// StreamGuard — demo database seed (idempotent-ish: wipes dynamic tables,
// keeps users/rules/settings; history is genuinely processed by the engine).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Run: bun run db:push && bun run seed
//
// What it builds:
// - users: admin/admin123 (ADMIN), analyst/analyst123 (ANALYST), viewer/viewer123 (VIEWER)
// - ingest key: keyId "demo-key-01", key value "sg-demo-ingest-key-2026"
//   (documented for the demo; stored as sha256(keyId + ':' + key))
// - the 7 CONTRACT rules (exact values) — created only if missing
// - default settings (created only if missing)
// - ~4.5 h of baseline history (~1900 events) + 5 attack windows, ALL ingested
//   through the real pipeline (rules + correlation run genuinely); then
//   incident lifecycle transitions (validated state machine) + notes.
//
// DEMO-DATA DISCLOSURE: historical events are replayed with plausible ingest
// times and processing latencies (historicalLatency: 4..43 ms); every
// detection/incident is produced by the actual engine — nothing is fabricated
// row-by-row.
import { db } from '@/lib/db'
import { hashIngestKey, hashPassword } from '@/lib/auth'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { wipeDynamicTables } from '@/lib/engine/reset'
import { ingestHistorical } from '@/lib/engine/history'
import { getScenario, generateBaseline, mulberry32, type RawEvent } from '@/lib/engine/simulator'
import { canTransition } from '@/lib/engine/incidents'
import { SEVERITIES } from '@/lib/types'

const MIN = 60_000
const T0 = Date.now()

// ---------- ensure static data (never overwritten on re-seed) ----------
async function ensureUsers(): Promise<void> {
  const users: Array<{ username: string; password: string; role: string; displayName: string }> = [
    { username: 'admin', password: 'admin123', role: 'ADMIN', displayName: 'Parsa Fathi (Admin)' },
    { username: 'analyst', password: 'analyst123', role: 'ANALYST', displayName: 'Sara Moradi (Analyst)' },
    { username: 'viewer', password: 'viewer123', role: 'VIEWER', displayName: 'Reza Karimi (Viewer)' },
  ]
  for (const u of users) {
    const existing = await db.user.findUnique({ where: { username: u.username } })
    if (existing) continue
    await db.user.create({
      data: { username: u.username, passwordHash: hashPassword(u.password), role: u.role, displayName: u.displayName },
    })
    console.log(`[seed] user ${u.username} (${u.role}) created`)
  }
}

async function ensureIngestKey(): Promise<void> {
  const existing = await db.ingestKey.findFirst({ where: { keyId: 'demo-key-01' } })
  if (existing) return
  await db.ingestKey.create({
    data: {
      keyId: 'demo-key-01',
      keyHash: hashIngestKey('demo-key-01', 'sg-demo-ingest-key-2026'), // demo key, documented; stored hashed
      active: true,
      name: 'Demo ingest key (value documented in seed comments)',
    },
  })
  console.log('[seed] ingest key demo-key-01 created (value: sg-demo-ingest-key-2026 — demo only)')
}

async function ensureRules(): Promise<void> {
  const rules: Array<{
    id: string; name: string; description: string; selectorJson: string
    conditionType: string; threshold: number; windowSeconds: number; severity: string
    cooldownSeconds: number; suppression: boolean
  }> = [
    {
      id: 'SG-RULE-001', name: 'Repeated Authentication Failures',
      description: 'Fires at >=5 failed auth events (category=auth, attributes.action=login_failed) for the same actor within 120 s.',
      selectorJson: '{"category":"auth","attribute":{"key":"action","value":"login_failed"},"correlationKey":"actor","comparison":"gte"}',
      conditionType: 'count', threshold: 5, windowSeconds: 120, severity: 'high', cooldownSeconds: 300, suppression: true,
    },
    {
      id: 'SG-RULE-002', name: 'Abnormal Request Rate',
      description: 'Fires at >120 request events (category=network, attributes.kind=request) from a single source within 60 s.',
      selectorJson: '{"category":"network","attribute":{"key":"kind","value":"request"},"correlationKey":"source_id","comparison":"gt"}',
      conditionType: 'count', threshold: 120, windowSeconds: 60, severity: 'medium', cooldownSeconds: 120, suppression: true,
    },
    {
      id: 'SG-RULE-003', name: 'Suspicious Auth Sequence',
      description: 'Fires at >=3 auth failures followed by a success for the same actor within 5 min (login_failed x3 -> login_success).',
      selectorJson: '{"category":"auth","correlationKey":"actor","sequence":[{"key":"action","value":"login_failed","count":3},{"key":"action","value":"login_success","count":1}]}',
      conditionType: 'sequence', threshold: 3, windowSeconds: 300, severity: 'high', cooldownSeconds: 300, suppression: true,
    },
    {
      id: 'SG-RULE-004', name: 'Error Rate Spike',
      description: 'Fires when the error ratio (category=application and [severity in medium/high/critical or attributes.error=true]) exceeds 30% over 300 s per source, with >=20 events in the window.',
      selectorJson: '{"category":"application","severity":["medium","high","critical"],"attribute":{"key":"error","value":"true"},"correlationKey":"source_id","comparison":"gt","minDenominator":20}',
      conditionType: 'ratio', threshold: 0.3, windowSeconds: 300, severity: 'medium', cooldownSeconds: 300, suppression: true,
    },
    {
      id: 'SG-RULE-005', name: 'Repeated Authorization Failures',
      description: 'Fires at >=3 authorization failures (category=security, attributes.action=access_denied) for the same actor within 5 min.',
      selectorJson: '{"category":"security","attribute":{"key":"action","value":"access_denied"},"correlationKey":"actor","comparison":"gte"}',
      conditionType: 'count', threshold: 3, windowSeconds: 300, severity: 'medium', cooldownSeconds: 300, suppression: true,
    },
    {
      id: 'SG-RULE-006', name: 'Unexpected Configuration Change',
      description: 'Fires on any config change (category=config, attributes.action=change) on source_type=infra or a source_id starting with prod-.',
      selectorJson: '{"category":"config","attribute":{"key":"action","value":"change"},"sourceTypes":["infra"],"sourceIdPrefix":"prod-","correlationKey":"source_id"}',
      conditionType: 'exists', threshold: 1, windowSeconds: 0, severity: 'high', cooldownSeconds: 0, suppression: false,
    },
    {
      id: 'SG-RULE-007', name: 'Ingestion Validation Failures',
      description: 'Fires at >=10 rejected events within 60 s (internal rule over validation failures; correlation key global).',
      selectorJson: '{"internal":"validation_failures","correlationKey":"global","comparison":"gte"}',
      conditionType: 'count', threshold: 10, windowSeconds: 60, severity: 'low', cooldownSeconds: 600, suppression: true,
    },
  ]
  for (const r of rules) {
    const existing = await db.rule.findUnique({ where: { id: r.id } })
    if (existing) continue
    await db.rule.create({
      data: {
        id: r.id, name: r.name, description: r.description, enabled: true, selectorJson: r.selectorJson,
        conditionType: r.conditionType, threshold: r.threshold, windowSeconds: r.windowSeconds,
        severity: r.severity, cooldownSeconds: r.cooldownSeconds, suppression: r.suppression, version: 1,
      },
    })
    await db.ruleAudit.create({
      data: { ruleId: r.id, actor: 'seed', action: 'created', changes: JSON.stringify({ seeded: true }) },
    })
    console.log(`[seed] rule ${r.id} created`)
  }
}

async function ensureSettings(): Promise<void> {
  const existing = await db.setting.findUnique({ where: { key: 'app' } })
  if (!existing) {
    await db.setting.create({ data: { key: 'app', value: JSON.stringify(DEFAULT_SETTINGS) } })
    console.log('[seed] default settings created')
  }
  const counter = await db.incidentCounter.findUnique({ where: { id: 'singleton' } })
  if (!counter) await db.incidentCounter.create({ data: { id: 'singleton', count: 0 } })
}

// ---------- history generation ----------
function buildHistory(): RawEvent[] {
  const raws: RawEvent[] = []
  const master = mulberry32(20260219) // fixed master seed -> deterministic history
  const endMs = T0 - 90_000
  const totalMinutes = 275
  // chronological baseline, ~5-8 events per minute (spread within each minute)
  for (let i = totalMinutes - 1; i >= 0; i--) {
    const minuteEnd = new Date(endMs - i * MIN)
    const count = 5 + Math.floor(master() * 4)
    raws.push(...generateBaseline(master, minuteEnd, count, 60))
  }
  // attack windows (deterministic per-window seeds)
  const windows: Array<{ scenarioId: string; offsetMin: number; seed: number }> = [
    { scenarioId: 'traffic_burst', offsetMin: 250, seed: 91001 },
    { scenarioId: 'brute_force', offsetMin: 190, seed: 91002 },
    { scenarioId: 'error_storm', offsetMin: 110, seed: 91003 },
    { scenarioId: 'authz_failures', offsetMin: 90, seed: 91004 },
    { scenarioId: 'config_change', offsetMin: 35, seed: 91005 },
  ]
  for (const w of windows) {
    const scenario = getScenario(w.scenarioId)
    if (!scenario) throw new Error(`scenario ${w.scenarioId} missing`)
    raws.push(...scenario.generate(mulberry32(w.seed), new Date(T0 - w.offsetMin * MIN)))
  }
  return raws
}

// ---------- validated lifecycle transitions (same state machine as the API) ----------
async function transition(
  id: string,
  to: string,
  actor: string,
  at: Date,
  opts: { resolutionSummary?: string; assignedTo?: string } = {},
): Promise<void> {
  const inc = await db.incident.findUnique({ where: { id } })
  if (!inc) throw new Error(`incident ${id} not found`)
  if (!canTransition(inc.status, to)) throw new Error(`invalid transition ${inc.status} -> ${to} for ${id}`)
  if (to === 'RESOLVED' && (opts.resolutionSummary ?? '').trim().length < 10) {
    throw new Error(`resolutionSummary required for ${id}`)
  }
  await db.incident.update({
    where: { id },
    data: {
      status: to,
      ...(to === 'RESOLVED' ? { resolvedAt: at, resolutionSummary: opts.resolutionSummary } : {}),
      ...(to === 'CLOSED' ? { closedAt: at } : {}),
      ...(opts.assignedTo !== undefined ? { assignedTo: opts.assignedTo } : {}),
      updatedAt: at,
    },
  })
  await db.incidentStatusHistory.create({
    data: { incidentId: id, fromStatus: inc.status, toStatus: to, actor, note: opts.resolutionSummary ?? null, ts: at },
  })
}

async function addNote(id: string, author: string, body: string, at: Date): Promise<void> {
  await db.incidentNote.create({ data: { incidentId: id, author, body, createdAt: at } })
}

// ---------- main ----------
async function main(): Promise<void> {
  console.log('[seed] StreamGuard demo seed starting')
  await ensureUsers()
  await ensureIngestKey()
  await ensureRules()
  await ensureSettings()

  console.log('[seed] wiping dynamic tables (users/rules/settings kept)')
  await wipeDynamicTables()

  const history = buildHistory()
  console.log(`[seed] replaying ${history.length} events through the real pipeline (~4.6 h of history)`)
  const summary = await ingestHistorical(history, { notify: false })
  console.log(`[seed] ingested accepted=${summary.accepted} rejected=${summary.rejected} duplicates=${summary.duplicates} chunks=${summary.chunks}`)

  const incidents = await db.incident.findMany({ orderBy: { createdAt: 'asc' } })
  console.log(`[seed] engine created ${incidents.length} incidents:`)
  for (const i of incidents) {
    console.log(`[seed]   ${i.id} ${i.ruleId} key=${i.correlationLabel}:${i.correlationKey} severity=${i.severity} events=${i.eventCount} (${i.title})`)
  }

  // lifecycle narratives (validated transitions, historical timestamps)
  const at = (offsetMin: number) => new Date(T0 - offsetMin * MIN)
  const byRule = (ruleId: string) => incidents.filter((i) => i.ruleId === ruleId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const rule2 = byRule('SG-RULE-002')[0]
  if (rule2) {
    await transition(rule2.id, 'TRIAGED', 'admin', at(246))
    await transition(rule2.id, 'INVESTIGATING', 'admin', at(243), { assignedTo: 'admin' })
    await transition(rule2.id, 'RESOLVED', 'admin', at(240), {
      resolutionSummary: 'Load-test job misconfiguration generated the burst; throttled at the gateway and the job was rescheduled. Rates verified normal for 30 min.',
    })
    await transition(rule2.id, 'CLOSED', 'admin', at(236))
  }
  const rule1 = byRule('SG-RULE-001')[0]
  if (rule1) {
    await transition(rule1.id, 'TRIAGED', 'analyst', at(186))
    await transition(rule1.id, 'RESOLVED', 'analyst', at(183), {
      resolutionSummary: 'Workstation isolated and user_admin credentials rotated; no evidence of lateral movement found in session logs.',
    })
  }
  const rule3 = byRule('SG-RULE-003')[0]
  if (rule3) {
    await transition(rule3.id, 'TRIAGED', 'analyst', at(185))
    await transition(rule3.id, 'INVESTIGATING', 'analyst', at(180), { assignedTo: 'analyst' })
    await transition(rule3.id, 'RESOLVED', 'analyst', at(178), {
      resolutionSummary: 'Successful login after failures traced to the password-reset flow; MFA challenge enforced and monitoring confirmed no repeat.',
    })
  }
  const rule4 = byRule('SG-RULE-004')[0]
  if (rule4) {
    await transition(rule4.id, 'TRIAGED', 'analyst', at(107))
    await transition(rule4.id, 'INVESTIGATING', 'analyst', at(104), { assignedTo: 'analyst' })
    await transition(rule4.id, 'RESOLVED', 'analyst', at(101), {
      resolutionSummary: 'Deploy v2.7.1 introduced an NPE in order-svc; rolled back to v2.7.0 and the error ratio recovered below 5%.',
    })
  }
  const rule5 = byRule('SG-RULE-005')[0]
  if (rule5) {
    await transition(rule5.id, 'TRIAGED', 'analyst', at(87), { assignedTo: 'analyst' })
    await transition(rule5.id, 'INVESTIGATING', 'analyst', at(84))
    await addNote(
      rule5.id, 'analyst',
      'svc_monitor was recently migrated to the new cluster; checking whether its role binding was dropped during the move — the admin endpoints require the ADMIN role.',
      at(80),
    )
    await addNote(
      rule5.id, 'admin',
      'Confirmed: role binding lost during the cluster migration. Platform fix pending; keeping the incident open until the binding is restored and re-tested.',
      at(76),
    )
  }
  const rule6 = byRule('SG-RULE-006')[0]
  if (rule6) {
    await addNote(
      rule6.id, 'analyst',
      'Out-of-window change on prod-db-01 flagged by SG-RULE-006. Operator svc_deploy claims scheduled maintenance, but the change ticket is missing. Confirming with the DBA team.',
      at(31),
    )
  }

  // final summary
  const [events, detections, dActive, dSupp, incAll, vf] = await Promise.all([
    db.event.count(),
    db.detection.count(),
    db.detection.count({ where: { status: 'ACTIVE' } }),
    db.detection.count({ where: { status: 'SUPPRESSED' } }),
    db.incident.findMany({ orderBy: { createdAt: 'asc' } }),
    db.validationFailure.count(),
  ])
  const byStatus = new Map<string, number>()
  for (const i of incAll) byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1)
  const sevCounts = new Map<string, number>()
  const sevRows = await db.event.groupBy({ by: ['severity'], _count: { _all: true } })
  for (const r of sevRows) sevCounts.set(r.severity, r._count._all)
  const sevLine = SEVERITIES.map((s) => `${s}=${sevCounts.get(s) ?? 0}`).join(' ')
  console.log('——— seed summary ———')
  console.log(`events=${events} (${sevLine})`)
  console.log(`detections=${detections} (active=${dActive}, suppressed=${dSupp}) validationFailures=${vf}`)
  console.log(`incidents=${incAll.length} ${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  for (const i of incAll) {
    console.log(`  ${i.id} [${i.status}] ${i.severity} ${i.ruleId} — ${i.title}`)
  }
  console.log('——— seed done ———')
}

main()
  .catch((err) => {
    console.error('[seed] FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect().catch(() => undefined)
  })
