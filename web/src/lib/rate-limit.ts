// StreamGuard — in-memory sliding-window rate limiter (per ingest identity).
// Copyright © 2026 Parsa Fathi — Apache-2.0
// Process-local by design (documented): resets on restart.

const buckets = new Map<string, number[]>()
const WINDOW_MS = 60_000

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
  remaining: number
}

export function checkRateLimit(key: string, limit: number): RateLimitResult {
  const now = Date.now()
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (arr.length >= limit) {
    const oldest = arr[0]
    const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000))
    buckets.set(key, arr)
    return { allowed: false, retryAfterSec, remaining: 0 }
  }
  arr.push(now)
  buckets.set(key, arr)
  if (buckets.size > 500) {
    // keep memory bounded: drop stale buckets
    for (const [k, v] of buckets) {
      if (!v.some((t) => now - t < WINDOW_MS)) buckets.delete(k)
    }
  }
  return { allowed: true, retryAfterSec: 0, remaining: limit - arr.length }
}
