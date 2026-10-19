// StreamGuard — process-wide engine mutex (promise-chain, HMR-safe).
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Serializes the ingest pipeline (validate -> store -> rules -> correlate)
// per process. This is the TS equivalent of the engine-mutex critical
// section the Go reference service shipped after CI caught the same race
// class (worklog Task 9, bug 1): without it, concurrent ingests interleave
// the cooldown check / correlation findFirst with their inserts, producing
// duplicate ACTIVE detections inside a cooldown window and duplicate
// incidents inside the correlation window.
//
// Single-process embedded engine => a promise-chain mutex is sufficient.
// The chain tail is cached on globalThis so Next.js dev hot-reloads reuse
// the same queue instead of forking parallel ones per module instance.
const g = globalThis as unknown as { __sgEngineLock?: Promise<unknown> }

export function withEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__sgEngineLock ?? Promise.resolve()).then(fn, fn)
  g.__sgEngineLock = run.catch(() => undefined)
  return run
}
