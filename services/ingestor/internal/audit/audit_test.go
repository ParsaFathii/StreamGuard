// Copyright © 2026 Parsa Fathi — Apache-2.0

package audit

import (
	"context"
	"errors"
	"testing"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// failingStore wraps a Store and makes InsertAudit fail, to prove Log is
// non-fatal at the call-site level and reports the error honestly.
type failingStore struct {
	store.Store
}

func (f *failingStore) InsertAudit(ctx context.Context, a *store.AuditEntry) error {
	return errors.New("disk on fire")
}

func TestClosedSets(t *testing.T) {
	if len(Actions) != 10 {
		t.Fatalf("expected 10 actions, got %d", len(Actions))
	}
	for _, a := range Actions {
		if !ValidAction(a) {
			t.Fatalf("action %q must validate against its own set", a)
		}
	}
	if ValidAction("ingest.bogus") || ValidAction("") {
		t.Fatalf("unknown actions must not validate")
	}
	for _, tt := range TargetTypes {
		if !ValidTargetType(tt) {
			t.Fatalf("targetType %q must validate against its own set", tt)
		}
	}
	if ValidTargetType("bogus") {
		t.Fatalf("unknown targetType must not validate")
	}
}

func TestLogWritesEntry(t *testing.T) {
	st := store.NewMemStore()
	err := Log(context.Background(), st, "admin", "ADMIN", "login", "session", "admin", map[string]any{"ok": true})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	entries, total, err := st.ListAudit(context.Background(), store.AuditFilter{}, 1, 10)
	if err != nil || total != 1 {
		t.Fatalf("ListAudit: total=%d err=%v", total, err)
	}
	e := entries[0]
	if e.Actor != "admin" || e.Role != "ADMIN" || e.Action != "login" ||
		e.TargetType != "session" || e.TargetID != "admin" {
		t.Fatalf("bad entry: %+v", e)
	}
	if e.ID == "" || e.TS.IsZero() {
		t.Fatalf("id/ts must be populated: %+v", e)
	}
	if e.Details["ok"] != true {
		t.Fatalf("details must round-trip: %+v", e.Details)
	}
}

func TestLogReportsStoreErrorsWithoutPanic(t *testing.T) {
	f := &failingStore{store.NewMemStore()}
	err := Log(context.Background(), f, "admin", "ADMIN", "logout", "session", "admin", nil)
	if err == nil {
		t.Fatalf("expected the store error to be surfaced")
	}
}
