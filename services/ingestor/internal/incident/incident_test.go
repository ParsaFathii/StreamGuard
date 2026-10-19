// Copyright © 2026 Parsa Fathi — Apache-2.0

package incident

import (
	"testing"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// TestValidTransitions is the exhaustive legal-transition matrix from the
// contract.
func TestValidTransitions(t *testing.T) {
	valid := []struct{ from, to string }{
		{store.IncidentNew, store.IncidentTriaged},
		{store.IncidentNew, store.IncidentInvestigating},
		{store.IncidentNew, store.IncidentResolved},
		{store.IncidentNew, store.IncidentClosed},
		{store.IncidentTriaged, store.IncidentInvestigating},
		{store.IncidentTriaged, store.IncidentResolved},
		{store.IncidentTriaged, store.IncidentClosed},
		{store.IncidentInvestigating, store.IncidentResolved},
		{store.IncidentInvestigating, store.IncidentClosed},
		{store.IncidentInvestigating, store.IncidentTriaged},
		{store.IncidentResolved, store.IncidentClosed},
		{store.IncidentResolved, store.IncidentInvestigating}, // reopen
		{store.IncidentClosed, store.IncidentInvestigating},   // ADMIN-only reopen
	}
	for _, tc := range valid {
		if !CanTransition(tc.from, tc.to) {
			t.Errorf("transition %s -> %s should be legal", tc.from, tc.to)
		}
		if err := ValidateTransition(tc.from, tc.to); err != nil {
			t.Errorf("ValidateTransition(%s,%s) = %v, want nil", tc.from, tc.to, err)
		}
	}
}

// TestInvalidTransitions covers every illegal combination.
func TestInvalidTransitions(t *testing.T) {
	statuses := store.IncidentStatuses
	for _, from := range statuses {
		for _, to := range statuses {
			if from == to {
				continue
			}
			if CanTransition(from, to) {
				continue
			}
			err := ValidateTransition(from, to)
			if err == nil {
				t.Errorf("transition %s -> %s must be rejected", from, to)
			}
			if _, ok := err.(*IllegalTransitionError); !ok {
				t.Errorf("transition %s -> %s: want IllegalTransitionError, got %T", from, to, err)
			}
		}
	}
	// Same-status transitions are 409 no-ops, not illegal transitions.
	for _, s := range statuses {
		err := ValidateTransition(s, s)
		if err == nil {
			t.Errorf("same-status %s -> %s must error", s, s)
		}
		if _, ok := err.(*SameStatusError); !ok {
			t.Errorf("same-status %s: want SameStatusError, got %T", s, err)
		}
	}
	// Specific contract-illegal moves:
	illegal := []struct{ from, to string }{
		{store.IncidentTriaged, store.IncidentNew},
		{store.IncidentResolved, store.IncidentNew},
		{store.IncidentResolved, store.IncidentTriaged},
		{store.IncidentClosed, store.IncidentNew},
		{store.IncidentClosed, store.IncidentTriaged},
		{store.IncidentClosed, store.IncidentResolved},
	}
	for _, tc := range illegal {
		if CanTransition(tc.from, tc.to) {
			t.Errorf("%s -> %s must be illegal", tc.from, tc.to)
		}
	}
}

func TestRequiresAdmin(t *testing.T) {
	if !RequiresAdmin(store.IncidentClosed, store.IncidentInvestigating) {
		t.Fatalf("CLOSED -> INVESTIGATING must require ADMIN")
	}
	for _, from := range []string{store.IncidentNew, store.IncidentTriaged, store.IncidentInvestigating, store.IncidentResolved} {
		for _, to := range store.IncidentStatuses {
			if RequiresAdmin(from, to) {
				t.Fatalf("%s -> %s must not require ADMIN", from, to)
			}
		}
	}
}

func TestResolutionSummary(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"Rotated credentials and blocked the attacker IP.", true},
		{"short", false},
		{"", false},
		{"   ", false},
		{"   padded but valid summary   ", true},
		{"1234567890", true}, // exactly 10
		{"123456789", false}, // 9
	}
	for _, tc := range cases {
		if got := ValidateResolutionSummary(tc.in); got != tc.want {
			t.Errorf("ValidateResolutionSummary(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestValidStatus(t *testing.T) {
	for _, s := range store.IncidentStatuses {
		if !ValidStatus(s) {
			t.Errorf("%s should be valid", s)
		}
	}
	for _, s := range []string{"", "open", "CANCELLED", "new"} {
		if ValidStatus(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}
