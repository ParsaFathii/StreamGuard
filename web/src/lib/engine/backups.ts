// StreamGuard — SQLite backup maintenance (VACUUM INTO snapshots + rotation).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Backups are consistent snapshots taken with SQLite's VACUUM INTO: it works
// under WAL while readers/writers keep going, and it compacts the file
// (vacuum) as a side benefit. Schedule: automatic, at most once every 24 h —
// state is persisted in Setting key "backup" so dev-server restarts and HMR
// don't reset the clock. The newest KEEP_BACKUPS files survive; older ones are
// pruned. Every run (auto or manual) writes an audit entry. Restore is
// deliberately a manual, documented procedure — never automatic:
//   1. stop the app   2. replace the DB file with the backup
//   3. delete the -wal/-shm sidecars   4. start the app
import fs from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { audit } from '@/lib/auth'
import { getBackupState, setBackupState } from '@/lib/settings'

export const KEEP_BACKUPS = 7
export const BACKUP_INTERVAL_MS = 24 * 3600 * 1000

function dbFile(): string {
  const url = process.env.DATABASE_URL ?? 'file:./db/custom.db'
  const p = url.startsWith('file:') ? url.slice(5) : url
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
}

function backupDir(): string {
  return path.join(path.dirname(dbFile()), 'backups')
}

function tsName(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export interface BackupInfo {
  name: string
  sizeBytes: number
  createdAt: string
}

export interface BackupResult {
  ok: boolean
  file?: string
  sizeBytes?: number
  durationMs?: number
  error?: string
}

async function vacuumInto(target: string): Promise<void> {
  // target is server-generated (timestamp only, never user input); quotes are
  // escaped defensively anyway so the statement can never break out.
  await db.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
}

function pruneBackupsSync(dir: string): number {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  const backups = entries
    .filter((e) => e.isFile() && /^sg-backup-[\w.-]+\.db$/.test(e.name))
    .map((e) => {
      const p = path.join(dir, e.name)
      try {
        return { p, mtime: fs.statSync(p).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { p: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const b of backups.slice(KEEP_BACKUPS)) {
    try {
      fs.rmSync(b.p, { force: true })
      removed++
    } catch {
      // best effort — the next run prunes again
    }
  }
  return removed
}

/** Take a backup now. Never throws — failures are reported in the result. */
export async function createBackup(now = new Date()): Promise<BackupResult> {
  const started = Date.now()
  try {
    const dir = backupDir()
    fs.mkdirSync(dir, { recursive: true })
    let name = `sg-backup-${tsName(now)}.db`
    let target = path.join(dir, name)
    for (let i = 1; fs.existsSync(target); i++) {
      name = `sg-backup-${tsName(now)}-${i}.db`
      target = path.join(dir, name)
    }
    await vacuumInto(target)
    const stat = fs.statSync(target)
    if (stat.size < 1024) {
      // a stub that small means VACUUM INTO failed silently — don't keep it
      fs.rmSync(target, { force: true })
      throw new Error('backup file suspiciously small — VACUUM INTO failed')
    }
    pruneBackupsSync(dir)
    const result: BackupResult = {
      ok: true,
      file: name,
      sizeBytes: stat.size,
      durationMs: Date.now() - started,
    }
    try {
      await setBackupState({ lastRunAt: now.toISOString(), lastResult: result })
    } catch {
      // state bookkeeping must not fail the backup itself
    }
    return result
  } catch (err) {
    const result: BackupResult = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    try {
      await setBackupState({ lastRunAt: now.toISOString(), lastResult: result })
    } catch {
      // never mask the original error with a bookkeeping failure
    }
    return result
  }
}

/** List existing backups + configuration (never throws). */
export function listBackups(): { dir: string; keep: number; backups: BackupInfo[] } {
  const dir = backupDir()
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => /^sg-backup-[\w.-]+\.db$/.test(n))
  } catch {
    // no dir yet — report empty
  }
  const backups = names
    .map((n) => {
      const p = path.join(dir, n)
      try {
        const s = fs.statSync(p)
        return { name: n, sizeBytes: s.size, createdAt: s.mtime.toISOString() }
      } catch {
        return null
      }
    })
    .filter((x): x is BackupInfo => x !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return { dir, keep: KEEP_BACKUPS, backups }
}

// ---- automatic schedule (at most once per 24 h; persisted across restarts;
// ------ the check itself is throttled to at most one DB read every 5 min) ----
interface BackupLoopState {
  lastCheck: number
  running: boolean
}
const g = globalThis as unknown as { __sgBackupLoop?: BackupLoopState }
const loop: BackupLoopState = g.__sgBackupLoop ?? (g.__sgBackupLoop = { lastCheck: 0, running: false })

export function maybeRunBackup(): void {
  const now = Date.now()
  if (loop.running || now - loop.lastCheck < 5 * 60 * 1000) return
  loop.lastCheck = now
  void (async () => {
    try {
      const state = await getBackupState()
      const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0
      if (Number.isFinite(last) && now - last < BACKUP_INTERVAL_MS) return
      loop.running = true
      const result = await createBackup()
      await audit({
        actor: 'system',
        role: 'SYSTEM',
        action: 'backup.auto',
        targetType: 'backup',
        targetId: result.file ?? undefined,
        details: result.ok
          ? { sizeBytes: result.sizeBytes ?? null, durationMs: result.durationMs ?? null }
          : { error: result.error ?? 'unknown' },
      })
    } catch {
      // the scheduler must never throw into its caller
    } finally {
      loop.running = false
    }
  })()
}
