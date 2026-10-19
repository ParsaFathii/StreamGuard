// StreamGuard — process-local counters (documented: reset on restart).
// Durable numbers come from DB aggregates in engine/metrics.ts; these cover
// what cannot be derived from the DB (duplicates, ingest HTTP codes, LLM calls).
// Copyright © 2026 Parsa Fathi — Apache-2.0

interface ProcStatsState {
  ingestDuplicates: number
  ingestByCode: Map<string, number>
  llmRequests: number
  llmFailures: number
  lastEventAt: number | null
  startedAt: number
}

const g = globalThis as unknown as { __sgProcStats?: ProcStatsState }
export const procStats: ProcStatsState =
  g.__sgProcStats ??
  (g.__sgProcStats = {
    ingestDuplicates: 0,
    ingestByCode: new Map<string, number>(),
    llmRequests: 0,
    llmFailures: 0,
    lastEventAt: null,
    startedAt: Date.now(),
  })

export function countIngest(code: string | number): void {
  const key = String(code)
  procStats.ingestByCode.set(key, (procStats.ingestByCode.get(key) ?? 0) + 1)
}

export function countDuplicates(n: number): void {
  procStats.ingestDuplicates += n
}

export function countLlmRequest(): void {
  procStats.llmRequests += 1
}

export function countLlmFailure(): void {
  procStats.llmFailures += 1
}

export function markLastEvent(ts: number): void {
  if (procStats.lastEventAt === null || ts > procStats.lastEventAt) procStats.lastEventAt = ts
}
