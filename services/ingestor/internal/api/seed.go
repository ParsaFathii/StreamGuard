// Copyright © 2026 Parsa Fathi — Apache-2.0

// Startup seeding: demo users (bcrypt), the 7 contract rules, default
// settings and the demo ingest key. All inserts are idempotent — seeding
// never clobbers runtime edits.
package api

import (
	"context"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/auth"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/rules"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// DefaultIngestKeyID is the seeded ingest key id (contract demo key).
const DefaultIngestKeyID = "demo-key-01"

// Seed brings an empty store to the contract demo state. It is safe to call
// on every start: users are only inserted when missing, rules use
// InsertRuleIfAbsent, settings use InitSettingsIfAbsent and the ingest key
// is upserted by id.
func Seed(ctx context.Context, st store.Store, as *auth.Service, ingestKeyValue string, initial store.Settings) error {
	// Users: only when the store has none (never clobbers password changes).
	if _, err := st.GetUser(ctx, "admin"); err == store.ErrNotFound {
		if err := as.SeedUsersIntoStore(ctx); err != nil {
			return err
		}
	}
	// Rules: insert-if-absent (never clobbers edits).
	if err := rules.SeedDefaults(ctx, st); err != nil {
		return err
	}
	// Settings: initialize once.
	if err := st.InitSettingsIfAbsent(ctx, initial); err != nil {
		return err
	}
	// Ingest key: upsert by id.
	if ingestKeyValue == "" {
		ingestKeyValue = "sg-demo-ingest-key-2026"
	}
	if err := st.UpsertIngestKey(ctx, &store.IngestKey{
		ID: DefaultIngestKeyID, Value: ingestKeyValue, Label: "demo ingest key (change INGEST_KEY!)", Active: true,
	}); err != nil {
		return err
	}
	return nil
}
