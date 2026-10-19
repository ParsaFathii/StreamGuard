// StreamGuard — historical (replay) ingestion helper shared by seeding and reset.
// Copyright © 2026 Parsa Fathi — Apache-2.0
//
// Events are ingested through the REAL pipeline in event_time order, in chunks
// of <= 100, with a plausible historical processing context (ctx.now/ingestTime
// anchored to the chunk's last event). This makes seeded history genuinely
// processed by the actual rule engine + correlation (no fabricated detections).
import type { RawEvent } from '@/lib/engine/simulator'
import { ingestEvents, type IngestResult } from '@/lib/engine/pipeline'

export interface HistoricalIngestSummary {
  accepted: number
  rejected: number
  duplicates: number
  chunks: number
}

export async function ingestHistorical(raws: RawEvent[], opts: { notify?: boolean } = {}): Promise<HistoricalIngestSummary> {
  const sorted = [...raws].sort((a, b) => String(a.event_time).localeCompare(String(b.event_time)))
  const summary: HistoricalIngestSummary = { accepted: 0, rejected: 0, duplicates: 0, chunks: 0 }
  const CHUNK = 100
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const chunk = sorted.slice(i, i + CHUNK)
    const lastEventTime = new Date(String(chunk[chunk.length - 1].event_time))
    const ingestTime = new Date(lastEventTime.getTime() + 30)
    const now = new Date(lastEventTime.getTime() + 120)
    const res: IngestResult = await ingestEvents(chunk, {
      now,
      ingestTime,
      origin: 'synthetic',
      notify: opts.notify ?? false,
      historicalLatency: true,
    })
    summary.accepted += res.accepted
    summary.rejected += res.rejected
    summary.duplicates += res.duplicates
    summary.chunks += 1
  }
  return summary
}
