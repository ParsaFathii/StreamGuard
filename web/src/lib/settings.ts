// StreamGuard — app settings (Setting table, key "app") + retention bookkeeping.
// Copyright © 2026 Parsa Fathi — Apache-2.0
import { db } from '@/lib/db'

export interface AppSettings {
  aiEnabled: boolean
  aiProvider: string
  correlationWindowSeconds: number
  retentionHours: number
  maxBatchSize: number
  rateLimitPerMin: number
  languageDefault: 'en' | 'fa'
}

export const DEFAULT_SETTINGS: AppSettings = {
  aiEnabled: true,
  aiProvider: 'sandbox-zai',
  correlationWindowSeconds: 600,
  retentionHours: 72,
  maxBatchSize: 100,
  rateLimitPerMin: 60,
  languageDefault: 'en',
}

const TTL_MS = 2000
let cache: { value: AppSettings; at: number } | null = null

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  let value: AppSettings = { ...DEFAULT_SETTINGS }
  try {
    const row = await db.setting.findUnique({ where: { key: 'app' } })
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<AppSettings>
      value = { ...DEFAULT_SETTINGS, ...parsed }
    }
  } catch {
    // fall back to defaults on any read error
  }
  cache = { value, at: Date.now() }
  return value
}

export function invalidateSettingsCache(): void {
  cache = null
}

export interface RetentionState {
  lastRunAt?: string
  deletedCount?: number
  totalDeleted?: number
}

export async function getRetentionState(): Promise<RetentionState> {
  try {
    const row = await db.setting.findUnique({ where: { key: 'retention' } })
    if (!row) return {}
    return JSON.parse(row.value) as RetentionState
  } catch {
    return {}
  }
}

export async function setRetentionState(state: RetentionState): Promise<void> {
  const merged = { ...(await getRetentionState()), ...state }
  await db.setting.upsert({
    where: { key: 'retention' },
    create: { key: 'retention', value: JSON.stringify(merged) },
    update: { value: JSON.stringify(merged) },
  })
}

// ---- backup bookkeeping (Setting key "backup") — mirrors the retention state pattern ----

export interface BackupState {
  lastRunAt?: string
  lastResult?: {
    ok: boolean
    file?: string
    sizeBytes?: number
    durationMs?: number
    error?: string
  }
}

export async function getBackupState(): Promise<BackupState> {
  try {
    const row = await db.setting.findUnique({ where: { key: 'backup' } })
    if (!row) return {}
    return JSON.parse(row.value) as BackupState
  } catch {
    return {}
  }
}

export async function setBackupState(state: BackupState): Promise<void> {
  const merged = { ...(await getBackupState()), ...state }
  await db.setting.upsert({
    where: { key: 'backup' },
    create: { key: 'backup', value: JSON.stringify(merged) },
    update: { value: JSON.stringify(merged) },
  })
}
