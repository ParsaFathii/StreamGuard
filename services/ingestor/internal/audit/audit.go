// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package audit writes immutable audit-trail entries to the store. Audit
// failures are logged but NEVER fail the enclosing request: the audit trail
// is an observability record, not a transaction participant.
package audit

import (
	"context"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// Closed sets of actions and target types written by this service. The
// /api/audit endpoint validates its `action` and `targetType` filters against
// these sets, so they must stay in sync with every Log call site.
var (
	// Actions is the closed set of audited actions.
	Actions = []string{
		"login",
		"logout",
		"rule.update",
		"incident.update",
		"incident.note",
		"ai.investigate",
		"simulator.run",
		"settings.update",
		"demo.reset",
		"retention.run",
	}

	// TargetTypes is the closed set of audited target types.
	TargetTypes = []string{
		"session",
		"rule",
		"incident",
		"simulator",
		"settings",
		"system",
	}
)

// ValidAction reports whether a is an action this service writes.
func ValidAction(a string) bool { return inSet(Actions, a) }

// ValidTargetType reports whether t is a target type this service writes.
func ValidTargetType(t string) bool { return inSet(TargetTypes, t) }

func inSet(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

// Log records one audit entry. It returns an error when the store write
// fails; callers should log the error and continue (never fail the request).
func Log(ctx context.Context, st store.Store, actor, role, action, targetType, targetID string, details map[string]any) error {
	entry := &store.AuditEntry{
		ID:         ids.New("AUD"),
		TS:         time.Now().UTC(),
		Actor:      actor,
		Role:       role,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		Details:    details,
	}
	return st.InsertAudit(ctx, entry)
}
