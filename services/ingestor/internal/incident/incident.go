// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package incident implements the incident lifecycle state machine with
// validated transitions only (enforced server-side).
package incident

import (
        "fmt"
        "strings"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// transitions is the contract-legal transition table.
var transitions = map[string][]string{
        store.IncidentNew:           {store.IncidentTriaged, store.IncidentInvestigating, store.IncidentResolved, store.IncidentClosed},
        store.IncidentTriaged:       {store.IncidentInvestigating, store.IncidentResolved, store.IncidentClosed},
        store.IncidentInvestigating: {store.IncidentResolved, store.IncidentClosed, store.IncidentTriaged},
        store.IncidentResolved:      {store.IncidentClosed, store.IncidentInvestigating}, // reopen
        store.IncidentClosed:        {store.IncidentInvestigating},                      // ADMIN-only reopen
}

// CanTransition reports whether from -> to is a legal lifecycle move.
func CanTransition(from, to string) bool {
        for _, t := range transitions[from] {
                if t == to {
                        return true
                }
        }
        return false
}

// RequiresAdmin reports whether the transition is restricted to ADMIN
// (reopen from CLOSED).
func RequiresAdmin(from, to string) bool {
        return from == store.IncidentClosed && to == store.IncidentInvestigating
}

// SameStatusError signals a no-op transition (mapped to HTTP 409).
type SameStatusError struct{ Status string }

func (e *SameStatusError) Error() string { return "incident is already in status " + e.Status }

// IllegalTransitionError signals a contract-illegal transition (HTTP 400).
type IllegalTransitionError struct{ From, To string }

func (e *IllegalTransitionError) Error() string {
        return fmt.Sprintf("illegal transition %s -> %s", e.From, e.To)
}

// ValidateTransition returns a descriptive error for illegal transitions.
func ValidateTransition(from, to string) error {
        if from == to {
                return &SameStatusError{Status: from}
        }
        if !CanTransition(from, to) {
                return &IllegalTransitionError{From: from, To: to}
        }
        return nil
}

// ValidStatus reports whether s is a known incident status.
func ValidStatus(s string) bool {
        for _, v := range store.IncidentStatuses {
                if v == s {
                        return true
                }
        }
        return false
}

// ValidateResolutionSummary enforces the >=10 chars requirement for
// resolution summaries.
func ValidateResolutionSummary(s string) bool {
        return len(strings.TrimSpace(s)) >= 10
}
