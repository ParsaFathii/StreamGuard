// StreamGuard — incident lifecycle (validated transitions, server-enforced).
// Copyright © 2026 Parsa Fathi — Apache-2.0

export const INCIDENT_STATUSES = ['NEW', 'TRIAGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

// CONTRACT transitions — validated server-side, invalid => 400 INVALID_TRANSITION
export const TRANSITIONS: Record<string, string[]> = {
  NEW: ['TRIAGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED'],
  TRIAGED: ['INVESTIGATING', 'RESOLVED', 'CLOSED'],
  INVESTIGATING: ['RESOLVED', 'CLOSED', 'TRIAGED'],
  RESOLVED: ['CLOSED', 'INVESTIGATING'], // reopen allowed
  CLOSED: ['INVESTIGATING'], // terminal; reopen via INVESTIGATING (ADMIN only — enforced by route)
}

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export interface TransitionInput {
  to: IncidentStatus
  actor: string
  note?: string
  resolutionSummary?: string
  now?: Date
}

export type TransitionResult =
  | { ok: true; from: string; to: string; resolved: boolean; closed: boolean; at: Date }
  | { ok: false; code: 'INVALID_TRANSITION' | 'RESOLUTION_REQUIRED'; message: string }

/** Validates a requested transition against the current state (pure check). */
export function validateTransition(current: string, to: string, resolutionSummaryCandidate?: string): TransitionResult {
  if (!INCIDENT_STATUSES.includes(to as IncidentStatus)) {
    return { ok: false, code: 'INVALID_TRANSITION', message: `unknown status '${to}'` }
  }
  if (!canTransition(current, to)) {
    return { ok: false, code: 'INVALID_TRANSITION', message: `invalid transition ${current} -> ${to}` }
  }
  if (to === 'RESOLVED') {
    const summary = (resolutionSummaryCandidate ?? '').trim()
    if (summary.length < 10) {
      return { ok: false, code: 'RESOLUTION_REQUIRED', message: 'resolving requires a resolutionSummary of at least 10 characters' }
    }
  }
  const now = new Date()
  return {
    ok: true,
    from: current,
    to,
    resolved: to === 'RESOLVED',
    closed: to === 'CLOSED',
    at: now,
  }
}
