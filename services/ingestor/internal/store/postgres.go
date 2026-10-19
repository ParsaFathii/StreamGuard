// Copyright © 2026 Parsa Fathi — Apache-2.0

// PostgresStore is the durable Store implementation (pgx v5). The schema is
// applied at startup under an advisory lock; all queries are parameterized.
// Nullable timestamps use the Go zero-time sentinel '0001-01-01 00:00:00+00'
// (see schema.sql). MemStore remains the unit-test store; PostgresStore is
// exercised by the `integration` build tag (see postgres_integration_test.go)
// and in CI with a real POSTGRES_DSN.
package store

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/event"
)

//go:embed schema.sql
var schemaSQL string

// advisoryLockKey is an arbitrary constant identifying this service's schema
// migration lock (same value must be used by every instance).
const advisoryLockKey = 727272727

// zeroSentinel is the SQL literal used for Go zero times.
const zeroSentinel = "timestamptz '0001-01-01 00:00:00+00'"

// PostgresStore implements Store on PostgreSQL.
type PostgresStore struct {
	pool *pgxpool.Pool
}

var _ Store = (*PostgresStore)(nil)

// NewPostgresStore opens a bounded connection pool, verifies connectivity and
// applies the schema under an advisory lock.
func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DSN: %w", err)
	}
	// Bounded pool: the ingestor is a small service.
	cfg.MaxConns = 8
	cfg.MinConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	if err := migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &PostgresStore{pool: pool}, nil
}

func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", advisoryLockKey); err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	defer conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", advisoryLockKey)
	// Every statement in schema.sql is idempotent.
	if _, err := conn.Exec(ctx, schemaSQL); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	return nil
}

// Close implements Store.
func (p *PostgresStore) Close() error {
	p.pool.Close()
	return nil
}

// Ping implements Store.
func (p *PostgresStore) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

func notFound(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func dup(err error) error {
	if err == nil {
		return nil
	}
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
		return ErrDuplicate
	}
	return err
}

// coalesce renders "COALESCE(col, <sentinel>) AS col".
func coalesce(col string) string {
	// No AS alias: function-call columns like max(ingest_time) cannot be
	// aliased unquoted (invalid SQL, caught by the PostgreSQL integration
	// suite), and every caller scans positionally.
	return fmt.Sprintf("COALESCE(%s, %s)", col, zeroSentinel)
}

// attrsJSON marshals an attribute map ("null" for nil).
func attrsJSON(m map[string]any) []byte {
	if m == nil {
		return []byte("null")
	}
	b, err := json.Marshal(m)
	if err != nil {
		return []byte("null")
	}
	return b
}

func attrsFromJSON(b []byte) (map[string]any, error) {
	if len(b) == 0 || string(b) == "null" {
		return nil, nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("null")
	}
	return b
}

// ---- events ----

const eventCols = "event_id, schema_version, event_time, source_id, source_type, severity, category, message, COALESCE(attributes, 'null'::jsonb), correlation_id, trace_id, actor, origin, ingest_time, status, rejection_reason, latency_ms"

func scanEvent(row pgx.Row) (*event.Event, error) {
	var e event.Event
	var attrs []byte
	if err := row.Scan(&e.EventID, &e.SchemaVersion, &e.EventTime, &e.SourceID, &e.SourceType,
		&e.Severity, &e.Category, &e.Message, &attrs, &e.CorrelationID, &e.TraceID, &e.Actor,
		&e.Origin, &e.IngestTime, &e.Status, &e.RejectionReason, &e.LatencyMs); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	m, err := attrsFromJSON(attrs)
	if err != nil {
		return nil, err
	}
	e.Attributes = m
	return &e, nil
}

// InsertEvent implements Store with idempotent semantics on event id.
func (p *PostgresStore) InsertEvent(ctx context.Context, e *event.Event) (bool, error) {
	var id string
	err := p.pool.QueryRow(ctx,
		`INSERT INTO events (event_id, schema_version, event_time, source_id, source_type, severity, category, message, attributes, correlation_id, trace_id, actor, origin, ingest_time, status, rejection_reason, latency_ms)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                 ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
		e.EventID, e.SchemaVersion, e.EventTime, e.SourceID, e.SourceType, e.Severity, e.Category,
		e.Message, attrsJSON(e.Attributes), e.CorrelationID, e.TraceID, e.Actor, e.Origin,
		e.IngestTime, e.Status, e.RejectionReason, e.LatencyMs).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // duplicate
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// GetEvent implements Store.
func (p *PostgresStore) GetEvent(ctx context.Context, id string) (*event.Event, error) {
	return scanEvent(p.pool.QueryRow(ctx,
		"SELECT "+eventCols+" FROM events WHERE event_id = $1", id))
}

// SetEventProcessed implements Store.
func (p *PostgresStore) SetEventProcessed(ctx context.Context, id string, latencyMs int64, at time.Time) error {
	tag, err := p.pool.Exec(ctx,
		"UPDATE events SET status='PROCESSED', latency_ms=$2 WHERE event_id = $1", id, latencyMs)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteEvents implements Store.
func (p *PostgresStore) DeleteEvents(ctx context.Context, ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := p.pool.Exec(ctx, "DELETE FROM events WHERE event_id = ANY($1)", ids)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// ListEvents implements Store (event_time desc, ingest_time desc).
func (p *PostgresStore) ListEvents(ctx context.Context, f EventFilter, page, pageSize int) ([]event.Event, int, error) {
	where, args := eventFilterWhere(f)
	count := 0
	if err := p.pool.QueryRow(ctx, "SELECT count(*) FROM events "+where, args...).Scan(&count); err != nil {
		return nil, 0, err
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 25
	}
	if pageSize > 10000 {
		pageSize = 10000
	}
	offset := (page - 1) * pageSize
	rows, err := p.pool.Query(ctx,
		"SELECT "+eventCols+" FROM events "+where+" ORDER BY event_time DESC, ingest_time DESC, event_id DESC LIMIT $"+fmt.Sprint(len(args)+1)+" OFFSET $"+fmt.Sprint(len(args)+2),
		append(args, pageSize, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]event.Event, 0, pageSize)
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *e)
	}
	return out, count, rows.Err()
}

func eventFilterWhere(f EventFilter) (string, []any) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(cond string, arg any) {
		args = append(args, arg)
		conds = append(conds, fmt.Sprintf(cond, "$"+fmt.Sprint(len(args))))
	}
	if len(f.Severities) > 0 {
		args = append(args, f.Severities)
		conds = append(conds, fmt.Sprintf("severity = ANY($%d)", len(args)))
	}
	if f.Category != "" {
		add("category = %s", f.Category)
	}
	if f.SourceID != "" {
		add("source_id = %s", f.SourceID)
	}
	if f.SourceType != "" {
		add("source_type = %s", f.SourceType)
	}
	if f.CorrelationID != "" {
		add("correlation_id = %s", f.CorrelationID)
	}
	if f.TraceID != "" {
		add("trace_id = %s", f.TraceID)
	}
	if f.Status != "" {
		add("status = %s", f.Status)
	}
	if f.Origin != "" {
		add("origin = %s", f.Origin)
	}
	if f.From != nil {
		add("event_time >= %s", *f.From)
	}
	if f.To != nil {
		add("event_time <= %s", *f.To)
	}
	if f.Q != "" {
		args = append(args, strings.ToLower(f.Q))
		q := fmt.Sprintf("(strpos(lower(message), $%d) > 0 OR strpos(lower(actor), $%d) > 0)", len(args), len(args))
		conds = append(conds, q)
	}
	if f.IncidentID != "" {
		args = append(args, f.IncidentID)
		conds = append(conds, fmt.Sprintf("event_id IN (SELECT event_id FROM incident_events WHERE incident_id = $%d)", len(args)))
	}
	if f.RuleID != "" {
		args = append(args, f.RuleID)
		conds = append(conds, fmt.Sprintf("event_id IN (SELECT event_id FROM detections WHERE rule_id = $%d AND event_id <> '')", len(args)))
	}
	return "WHERE " + strings.Join(conds, " AND "), args
}

// QueryEvents implements Store (rule-engine selector query, time-ordered asc).
func (p *PostgresStore) QueryEvents(ctx context.Context, q EventQuery) ([]event.Event, error) {
	sql, args := queryEventsSQL(q)
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]event.Event, 0, 64)
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

func likePrefix(p string) string {
	return strings.ReplaceAll(p, "%", "") + "%"
}

// queryEventsSQL builds the selector query with proper placeholders.
func queryEventsSQL(q EventQuery) (string, []any) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, arg any) string {
		args = append(args, arg)
		return fmt.Sprintf(format, "$"+fmt.Sprint(len(args)))
	}
	if len(q.Categories) > 0 {
		args = append(args, q.Categories)
		conds = append(conds, fmt.Sprintf("category = ANY($%d)", len(args)))
	}
	if len(q.Severities) > 0 {
		args = append(args, q.Severities)
		conds = append(conds, fmt.Sprintf("severity = ANY($%d)", len(args)))
	}
	if q.SourceIDPrefix != "" {
		conds = append(conds, add("source_id LIKE %s", likePrefix(q.SourceIDPrefix)))
	}
	if q.AttrKey != "" {
		c1 := add("(COALESCE(attributes->>%s,'') = ", q.AttrKey)
		c2 := add("%s)", q.AttrValue)
		conds = append(conds, c1+c2)
	}
	if !q.Since.IsZero() {
		conds = append(conds, add("event_time >= %s", q.Since))
	}
	if !q.Until.IsZero() {
		conds = append(conds, add("event_time <= %s", q.Until))
	}
	limit := q.Limit
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	return "SELECT " + eventCols + " FROM events WHERE " + strings.Join(conds[1:], " AND ") +
		" ORDER BY event_time ASC, event_id ASC LIMIT " + fmt.Sprint(limit), args
}

// CountEventsSince implements Store.
func (p *PostgresStore) CountEventsSince(ctx context.Context, since time.Time) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx, "SELECT count(*) FROM events WHERE ingest_time >= $1", since).Scan(&n)
	return n, err
}

// SeverityBreakdownSince implements Store.
func (p *PostgresStore) SeverityBreakdownSince(ctx context.Context, since time.Time) (map[string]int64, error) {
	return p.breakdownSince(ctx, since, "severity")
}

// CategoryBreakdownSince implements Store.
func (p *PostgresStore) CategoryBreakdownSince(ctx context.Context, since time.Time) (map[string]int64, error) {
	return p.breakdownSince(ctx, since, "category")
}

func (p *PostgresStore) breakdownSince(ctx context.Context, since time.Time, col string) (map[string]int64, error) {
	rows, err := p.pool.Query(ctx,
		"SELECT "+col+", count(*) FROM events WHERE ingest_time >= $1 GROUP BY "+col, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]int64)
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, rows.Err()
}

// TopSourcesSince implements Store.
func (p *PostgresStore) TopSourcesSince(ctx context.Context, since time.Time, n int) ([]SourceCount, error) {
	rows, err := p.pool.Query(ctx,
		"SELECT source_id, count(*) AS c FROM events WHERE ingest_time >= $1 GROUP BY source_id ORDER BY c DESC, source_id ASC LIMIT $2", since, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceCount{}
	for rows.Next() {
		var sc SourceCount
		if err := rows.Scan(&sc.SourceID, &sc.Count); err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// MinuteCounts implements Store (kind: events|detections|rejected).
func (p *PostgresStore) MinuteCounts(ctx context.Context, kind string, since time.Time) ([]MinuteCount, error) {
	var sql string
	switch kind {
	case "events":
		sql = "SELECT date_trunc('minute', ingest_time) AS m, count(*) FROM events WHERE ingest_time >= $1 GROUP BY m"
	case "rejected":
		sql = "SELECT date_trunc('minute', ingest_time) AS m, count(*) FROM events WHERE status='REJECTED' AND ingest_time >= $1 GROUP BY m"
	case "detections":
		sql = "SELECT date_trunc('minute', created_at) AS m, count(*) FROM detections WHERE created_at >= $1 GROUP BY m"
	default:
		return nil, ErrNotFound
	}
	rows, err := p.pool.Query(ctx, sql, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MinuteCount{}
	for rows.Next() {
		var mc MinuteCount
		if err := rows.Scan(&mc.Minute, &mc.Count); err != nil {
			return nil, err
		}
		mc.Minute = mc.Minute.UTC()
		out = append(out, mc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Minute.Before(out[j].Minute) })
	return out, rows.Err()
}

// LatencyStatsSince implements Store.
func (p *PostgresStore) LatencyStatsSince(ctx context.Context, since time.Time) (float64, float64, time.Time, error) {
	var avg, p95 float64
	var last time.Time
	err := p.pool.QueryRow(ctx,
		`SELECT COALESCE(avg(latency_ms),0),
                        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms),0),
                        `+coalesce("max(ingest_time)")+`
                 FROM events WHERE status='PROCESSED' AND ingest_time >= $1`, since).
		Scan(&avg, &p95, &last)
	if err != nil {
		return 0, 0, time.Time{}, err
	}
	return avg, p95, last, nil
}

// SourcesSince implements Store (derived from real events only).
func (p *PostgresStore) SourcesSince(ctx context.Context, since time.Time) ([]SourceStat, error) {
	// type/origin from the earliest event of the source; lastStatus from the
	// newest event (matches MemStore iteration-order semantics).
	rows, err := p.pool.Query(ctx, `
                SELECT source_id,
                       (array_agg(source_type ORDER BY ingest_time ASC, event_id ASC))[1] AS type,
                       (array_agg(origin ORDER BY ingest_time ASC, event_id ASC))[1] AS origin,
                       count(*) FILTER (WHERE ingest_time >= $1) AS events_recent,
                       `+coalesce("max(ingest_time)")+`,
                       (array_agg(status ORDER BY ingest_time DESC, event_id DESC))[1] AS last_status
                FROM events
                GROUP BY source_id
                ORDER BY source_id ASC`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceStat{}
	for rows.Next() {
		var s SourceStat
		if err := rows.Scan(&s.ID, &s.Type, &s.Origin, &s.Events24h, &s.LastEventAt, &s.LastStatus); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DeleteEventsBefore implements Store; events attached to incidents that are
// not CLOSED are never deleted.
func (p *PostgresStore) DeleteEventsBefore(ctx context.Context, cutoff time.Time) (int, error) {
	tag, err := p.pool.Exec(ctx, `
                DELETE FROM events
                WHERE ingest_time < $1
                  AND event_id NOT IN (
                    SELECT ie.event_id FROM incident_events ie
                    JOIN incidents i ON i.id = ie.incident_id
                    WHERE i.status <> 'CLOSED'
                  )`, cutoff)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// ---- validation failures ----

// InsertValidationFailure implements Store.
func (p *PostgresStore) InsertValidationFailure(ctx context.Context, vf *ValidationFailure) error {
	_, err := p.pool.Exec(ctx,
		"INSERT INTO validation_failures (id, ts, reason, detail) VALUES ($1,$2,$3,$4)",
		vf.ID, vf.TS, vf.Reason, vf.Detail)
	return err
}

// ListValidationFailuresSince implements Store (newest first, bounded).
func (p *PostgresStore) ListValidationFailuresSince(ctx context.Context, since time.Time, limit int) ([]ValidationFailure, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx,
		"SELECT id, ts, reason, detail FROM validation_failures WHERE ts >= $1 ORDER BY ts DESC LIMIT $2", since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ValidationFailure{}
	for rows.Next() {
		var vf ValidationFailure
		if err := rows.Scan(&vf.ID, &vf.TS, &vf.Reason, &vf.Detail); err != nil {
			return nil, err
		}
		out = append(out, vf)
	}
	return out, rows.Err()
}

// ---- rules ----

const ruleCols = "id, name, description, enabled, COALESCE(selector,'{}'::jsonb), COALESCE(condition,'{}'::jsonb), severity, cooldown_seconds, suppression, version, updated_at"

type ruleSelectorWire struct {
	Category       string   `json:"category,omitempty"`
	Severities     []string `json:"severity,omitempty"`
	SourceIDPrefix string   `json:"sourceIdPrefix,omitempty"`
	Attribute      *AttrKV  `json:"attribute,omitempty"`
}

func selectorToJSON(s RuleSelector) []byte { return mustJSON(ruleSelectorWire(s)) }

func selectorFromJSON(b []byte) (RuleSelector, error) {
	var w ruleSelectorWire
	if err := json.Unmarshal(b, &w); err != nil {
		return RuleSelector{}, err
	}
	return RuleSelector(w), nil
}

func scanRule(row pgx.Row) (*Rule, error) {
	var r Rule
	var sel, cond []byte
	if err := row.Scan(&r.ID, &r.Name, &r.Description, &r.Enabled, &sel, &cond, &r.Severity,
		&r.CooldownSeconds, &r.Suppression, &r.Version, &r.UpdatedAt); err != nil {
		return nil, notFound(err)
	}
	s, err := selectorFromJSON(sel)
	if err != nil {
		return nil, err
	}
	r.Selector = s
	if err := json.Unmarshal(cond, &r.Condition); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListRules implements Store (ordered by id).
func (p *PostgresStore) ListRules(ctx context.Context) ([]Rule, error) {
	rows, err := p.pool.Query(ctx, "SELECT "+ruleCols+" FROM rules ORDER BY id ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// GetRule implements Store.
func (p *PostgresStore) GetRule(ctx context.Context, id string) (*Rule, error) {
	return scanRule(p.pool.QueryRow(ctx, "SELECT "+ruleCols+" FROM rules WHERE id = $1", id))
}

// InsertRuleIfAbsent implements Store (seeding must not clobber edits).
func (p *PostgresStore) InsertRuleIfAbsent(ctx context.Context, r *Rule) (bool, error) {
	var id string
	err := p.pool.QueryRow(ctx,
		`INSERT INTO rules (id, name, description, enabled, selector, condition, severity, cooldown_seconds, suppression, version, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 ON CONFLICT (id) DO NOTHING RETURNING id`,
		r.ID, r.Name, r.Description, r.Enabled, selectorToJSON(r.Selector), mustJSON(r.Condition),
		r.Severity, r.CooldownSeconds, r.Suppression, r.Version, r.UpdatedAt).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// UpdateRule implements Store.
func (p *PostgresStore) UpdateRule(ctx context.Context, r *Rule) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE rules SET name=$2, description=$3, enabled=$4, selector=$5, condition=$6,
                 severity=$7, cooldown_seconds=$8, suppression=$9, version=$10, updated_at=$11 WHERE id=$1`,
		r.ID, r.Name, r.Description, r.Enabled, selectorToJSON(r.Selector), mustJSON(r.Condition),
		r.Severity, r.CooldownSeconds, r.Suppression, r.Version, r.UpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// InsertRuleAudit implements Store.
func (p *PostgresStore) InsertRuleAudit(ctx context.Context, ra *RuleAudit) error {
	_, err := p.pool.Exec(ctx,
		"INSERT INTO rule_audit (id, ts, rule_id, actor, changes) VALUES ($1,$2,$3,$4,$5)",
		ra.ID, ra.TS, ra.RuleID, ra.Actor, mustJSON(ra.Changes))
	return err
}

// ListRuleAudit implements Store (newest first).
func (p *PostgresStore) ListRuleAudit(ctx context.Context, ruleID string, limit int) ([]RuleAudit, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx,
		"SELECT id, ts, rule_id, actor, COALESCE(changes,'{}'::jsonb) FROM rule_audit WHERE rule_id=$1 ORDER BY ts DESC LIMIT $2", ruleID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RuleAudit{}
	for rows.Next() {
		var ra RuleAudit
		var changes []byte
		if err := rows.Scan(&ra.ID, &ra.TS, &ra.RuleID, &ra.Actor, &changes); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(changes, &ra.Changes); err != nil {
			return nil, err
		}
		if ra.Changes == nil {
			ra.Changes = map[string]any{}
		}
		out = append(out, ra)
	}
	return out, rows.Err()
}

// ---- detections ----

const detCols = "id, rule_id, event_id, incident_id, correlation_key, severity, score, title, COALESCE(detail,'{}'::jsonb), status, created_at"

func scanDetection(row pgx.Row) (*Detection, error) {
	var d Detection
	var detail []byte
	if err := row.Scan(&d.ID, &d.RuleID, &d.EventID, &d.IncidentID, &d.CorrelationKey, &d.Severity,
		&d.Score, &d.Title, &detail, &d.Status, &d.CreatedAt); err != nil {
		return nil, notFound(err)
	}
	var w struct {
		MatchedCount   int      `json:"matchedCount"`
		WindowSeconds  int      `json:"windowSeconds"`
		Actor          string   `json:"actor,omitempty"`
		SourceID       string   `json:"sourceId,omitempty"`
		SampleEventIDs []string `json:"sampleEventIds"`
	}
	if err := json.Unmarshal(detail, &w); err != nil {
		return nil, err
	}
	d.Detail = DetectionDetail{
		MatchedCount:   w.MatchedCount,
		WindowSeconds:  w.WindowSeconds,
		Actor:          w.Actor,
		SourceID:       w.SourceID,
		SampleEventIDs: w.SampleEventIDs,
	}
	if d.Detail.SampleEventIDs == nil {
		d.Detail.SampleEventIDs = []string{}
	}
	return &d, nil
}

// InsertDetection implements Store.
func (p *PostgresStore) InsertDetection(ctx context.Context, d *Detection) error {
	detail := map[string]any{
		"matchedCount":   d.Detail.MatchedCount,
		"windowSeconds":  d.Detail.WindowSeconds,
		"sampleEventIds": d.Detail.SampleEventIDs,
	}
	if d.Detail.Actor != "" {
		detail["actor"] = d.Detail.Actor
	}
	if d.Detail.SourceID != "" {
		detail["sourceId"] = d.Detail.SourceID
	}
	_, err := p.pool.Exec(ctx,
		`INSERT INTO detections (id, rule_id, event_id, incident_id, correlation_key, severity, score, title, detail, status, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		d.ID, d.RuleID, d.EventID, d.IncidentID, d.CorrelationKey, d.Severity, d.Score, d.Title,
		mustJSON(detail), d.Status, d.CreatedAt)
	return err
}

// ListDetections implements Store (newest first).
func (p *PostgresStore) ListDetections(ctx context.Context, f DetectionFilter, page, pageSize int) ([]Detection, int, error) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, arg any) string {
		args = append(args, arg)
		return fmt.Sprintf(format, "$"+fmt.Sprint(len(args)))
	}
	if f.RuleID != "" {
		conds = append(conds, add("rule_id = %s", f.RuleID))
	}
	if f.Severity != "" {
		conds = append(conds, add("severity = %s", f.Severity))
	}
	if f.IncidentID != "" {
		conds = append(conds, add("incident_id = %s", f.IncidentID))
	}
	if f.Status != "" {
		conds = append(conds, add("status = %s", f.Status))
	}
	if f.From != nil {
		conds = append(conds, add("created_at >= %s", *f.From))
	}
	if f.To != nil {
		conds = append(conds, add("created_at <= %s", *f.To))
	}
	where := "WHERE " + strings.Join(conds, " AND ")
	var total int
	if err := p.pool.QueryRow(ctx, "SELECT count(*) FROM detections "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 25
	}
	if pageSize > 10000 {
		pageSize = 10000
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := p.pool.Query(ctx,
		"SELECT "+detCols+" FROM detections "+where+" ORDER BY created_at DESC, id DESC LIMIT $"+fmt.Sprint(len(args)-1)+" OFFSET $"+fmt.Sprint(len(args)),
		args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]Detection, 0, pageSize)
	for rows.Next() {
		d, err := scanDetection(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *d)
	}
	return out, total, rows.Err()
}

// DetectionCountsByRuleSince implements Store.
func (p *PostgresStore) DetectionCountsByRuleSince(ctx context.Context, since time.Time) (map[string]int64, error) {
	rows, err := p.pool.Query(ctx,
		"SELECT rule_id, count(*) FROM detections WHERE created_at >= $1 GROUP BY rule_id", since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]int64)
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, rows.Err()
}

// LastFiredByRule implements Store.
func (p *PostgresStore) LastFiredByRule(ctx context.Context) (map[string]time.Time, error) {
	rows, err := p.pool.Query(ctx,
		"SELECT rule_id, max(created_at) FROM detections GROUP BY rule_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]time.Time)
	for rows.Next() {
		var k string
		var t time.Time
		if err := rows.Scan(&k, &t); err != nil {
			return nil, err
		}
		out[k] = t
	}
	return out, rows.Err()
}

// LastDetectionAtByRuleKey implements Store (cooldown check).
func (p *PostgresStore) LastDetectionAtByRuleKey(ctx context.Context, ruleID string) (map[string]time.Time, error) {
	rows, err := p.pool.Query(ctx,
		"SELECT correlation_key, max(created_at) FROM detections WHERE rule_id = $1 GROUP BY correlation_key", ruleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]time.Time)
	for rows.Next() {
		var k string
		var t time.Time
		if err := rows.Scan(&k, &t); err != nil {
			return nil, err
		}
		out[k] = t
	}
	return out, rows.Err()
}

// ---- incidents ----

const incCols = "id, title, severity, status, rule_id, correlation_key, correlation_label, event_count, detection_count, first_event_time, last_event_time, assigned_to, resolution_summary, created_at, updated_at, resolved_at, closed_at, COALESCE(status_history,'[]'::jsonb)"

type historyWire struct {
	FromStatus string    `json:"from"`
	ToStatus   string    `json:"to"`
	Actor      string    `json:"actor"`
	Note       string    `json:"note,omitempty"`
	TS         time.Time `json:"at"`
}

func historyToJSON(h []StatusHistoryEntry) []byte {
	if h == nil {
		return []byte("[]")
	}
	w := make([]historyWire, 0, len(h))
	for _, e := range h {
		w = append(w, historyWire{FromStatus: e.FromStatus, ToStatus: e.ToStatus, Actor: e.Actor, Note: e.Note, TS: e.TS})
	}
	return mustJSON(w)
}

func scanIncident(row pgx.Row) (*Incident, error) {
	var inc Incident
	var hist []byte
	if err := row.Scan(&inc.ID, &inc.Title, &inc.Severity, &inc.Status, &inc.RuleID,
		&inc.CorrelationKey, &inc.CorrelationLabel, &inc.EventCount, &inc.DetectionCount,
		&inc.FirstEventTime, &inc.LastEventTime, &inc.AssignedTo, &inc.ResolutionSummary,
		&inc.CreatedAt, &inc.UpdatedAt, &inc.ResolvedAt, &inc.ClosedAt, &hist); err != nil {
		return nil, notFound(err)
	}
	var w []historyWire
	if err := json.Unmarshal(hist, &w); err != nil {
		return nil, err
	}
	inc.StatusHistory = make([]StatusHistoryEntry, 0, len(w))
	for _, e := range w {
		inc.StatusHistory = append(inc.StatusHistory, StatusHistoryEntry{
			FromStatus: e.FromStatus, ToStatus: e.ToStatus, Actor: e.Actor, Note: e.Note, TS: e.TS,
		})
	}
	return &inc, nil
}

// NextIncidentNumber implements Store (sequential INC-%06d).
func (p *PostgresStore) NextIncidentNumber(ctx context.Context) (int, error) {
	var n int64
	if err := p.pool.QueryRow(ctx, "SELECT nextval('incident_seq')").Scan(&n); err != nil {
		return 0, err
	}
	return int(n), nil
}

// InsertIncident implements Store.
func (p *PostgresStore) InsertIncident(ctx context.Context, inc *Incident) error {
	_, err := p.pool.Exec(ctx,
		`INSERT INTO incidents (id, title, severity, status, rule_id, correlation_key, correlation_label,
                   event_count, detection_count, first_event_time, last_event_time, assigned_to, resolution_summary,
                   created_at, updated_at, resolved_at, closed_at, status_history)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
		inc.ID, inc.Title, inc.Severity, inc.Status, inc.RuleID, inc.CorrelationKey, inc.CorrelationLabel,
		inc.EventCount, inc.DetectionCount, inc.FirstEventTime, inc.LastEventTime, inc.AssignedTo,
		inc.ResolutionSummary, inc.CreatedAt, inc.UpdatedAt, inc.ResolvedAt, inc.ClosedAt,
		historyToJSON(inc.StatusHistory))
	return dup(err)
}

// GetIncident implements Store.
func (p *PostgresStore) GetIncident(ctx context.Context, id string) (*Incident, error) {
	return scanIncident(p.pool.QueryRow(ctx, "SELECT "+incCols+" FROM incidents WHERE id = $1", id))
}

// UpdateIncident implements Store.
func (p *PostgresStore) UpdateIncident(ctx context.Context, inc *Incident) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE incidents SET title=$2, severity=$3, status=$4, rule_id=$5, correlation_key=$6,
                   correlation_label=$7, event_count=$8, detection_count=$9, first_event_time=$10, last_event_time=$11,
                   assigned_to=$12, resolution_summary=$13, updated_at=$14, resolved_at=$15, closed_at=$16,
                   status_history=$17 WHERE id=$1`,
		inc.ID, inc.Title, inc.Severity, inc.Status, inc.RuleID, inc.CorrelationKey, inc.CorrelationLabel,
		inc.EventCount, inc.DetectionCount, inc.FirstEventTime, inc.LastEventTime, inc.AssignedTo,
		inc.ResolutionSummary, inc.UpdatedAt, inc.ResolvedAt, inc.ClosedAt, historyToJSON(inc.StatusHistory))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListIncidents implements Store; sort: createdAt|severity|updatedAt (desc).
func (p *PostgresStore) ListIncidents(ctx context.Context, f IncidentFilter, sortKey string, page, pageSize int) ([]Incident, int, error) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, arg any) string {
		args = append(args, arg)
		return fmt.Sprintf(format, "$"+fmt.Sprint(len(args)))
	}
	if f.Status != "" {
		conds = append(conds, add("status = %s", f.Status))
	}
	if f.Severity != "" {
		conds = append(conds, add("severity = %s", f.Severity))
	}
	if f.RuleID != "" {
		conds = append(conds, add("rule_id = %s", f.RuleID))
	}
	if f.AssignedTo != "" {
		conds = append(conds, add("assigned_to = %s", f.AssignedTo))
	}
	if f.Since != nil {
		conds = append(conds, add("created_at >= %s", *f.Since))
	}
	if f.Q != "" {
		args = append(args, strings.ToLower(f.Q))
		q := fmt.Sprintf("(strpos(lower(title), $%d) > 0 OR strpos(lower(correlation_key), $%d) > 0 OR strpos(lower(id), $%d) > 0)", len(args), len(args), len(args))
		conds = append(conds, q)
	}
	where := "WHERE " + strings.Join(conds, " AND ")
	var total int
	if err := p.pool.QueryRow(ctx, "SELECT count(*) FROM incidents "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := "created_at DESC"
	switch sortKey {
	case "severity":
		order = "CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, created_at DESC"
	case "updatedAt":
		order = "updated_at DESC"
	case "createdAt", "":
		order = "created_at DESC"
	default:
		return nil, 0, ErrNotFound
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 25
	}
	if pageSize > 10000 {
		pageSize = 10000
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := p.pool.Query(ctx,
		"SELECT "+incCols+" FROM incidents "+where+" ORDER BY "+order+" LIMIT $"+fmt.Sprint(len(args)-1)+" OFFSET $"+fmt.Sprint(len(args)),
		args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]Incident, 0, pageSize)
	for rows.Next() {
		inc, err := scanIncident(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *inc)
	}
	return out, total, rows.Err()
}

// FindOpenIncident implements Store (open = not RESOLVED/CLOSED).
func (p *PostgresStore) FindOpenIncident(ctx context.Context, ruleID, correlationKey string, updatedSince time.Time) (*Incident, error) {
	return scanIncident(p.pool.QueryRow(ctx,
		`SELECT `+incCols+` FROM incidents
                 WHERE rule_id=$1 AND correlation_key=$2 AND status NOT IN ('RESOLVED','CLOSED') AND updated_at >= $3
                 ORDER BY updated_at DESC LIMIT 1`, ruleID, correlationKey, updatedSince))
}

// AttachIncidentEvents implements Store (idempotent per (incident,event)).
func (p *PostgresStore) AttachIncidentEvents(ctx context.Context, incidentID string, evs []IncidentEvent) (int, error) {
	if len(evs) == 0 {
		return 0, nil
	}
	var exists bool
	if err := p.pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM incidents WHERE id=$1)", incidentID).Scan(&exists); err != nil {
		return 0, err
	}
	if !exists {
		return 0, ErrNotFound
	}
	n := 0
	for _, ie := range evs {
		tag, err := p.pool.Exec(ctx,
			`INSERT INTO incident_events (incident_id, event_id, late, attached_at)
                         VALUES ($1,$2,$3,$4) ON CONFLICT (incident_id, event_id) DO NOTHING`,
			incidentID, ie.EventID, ie.Late, time.Now().UTC())
		if err != nil {
			return n, err
		}
		n += int(tag.RowsAffected())
	}
	return n, nil
}

// IncidentEvents implements Store (event_time asc, paginated, with late flag).
func (p *PostgresStore) IncidentEvents(ctx context.Context, incidentID string, page, pageSize int) ([]IncidentEventView, int, error) {
	var total int
	if err := p.pool.QueryRow(ctx,
		"SELECT count(*) FROM incident_events ie JOIN events e ON e.event_id = ie.event_id WHERE ie.incident_id = $1", incidentID).Scan(&total); err != nil {
		return nil, 0, err
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 25
	}
	if pageSize > 10000 {
		pageSize = 10000
	}
	// eventCols must be e.-qualified here: event_id exists in BOTH tables.
	qCols := "e.event_id, e.schema_version, e.event_time, e.source_id, e.source_type, e.severity, e.category, e.message, COALESCE(e.attributes, 'null'::jsonb), e.correlation_id, e.trace_id, e.actor, e.origin, e.ingest_time, e.status, e.rejection_reason, e.latency_ms"
	rows, err := p.pool.Query(ctx,
		"SELECT "+qCols+", ie.late FROM incident_events ie JOIN events e ON e.event_id = ie.event_id WHERE ie.incident_id = $1 ORDER BY e.event_time ASC, e.event_id ASC LIMIT $2 OFFSET $3",
		incidentID, pageSize, (page-1)*pageSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]IncidentEventView, 0, pageSize)
	for rows.Next() {
		var e event.Event
		var attrs []byte
		var late bool
		if err := rows.Scan(&e.EventID, &e.SchemaVersion, &e.EventTime, &e.SourceID, &e.SourceType,
			&e.Severity, &e.Category, &e.Message, &attrs, &e.CorrelationID, &e.TraceID, &e.Actor,
			&e.Origin, &e.IngestTime, &e.Status, &e.RejectionReason, &e.LatencyMs, &late); err != nil {
			return nil, 0, err
		}
		m, err := attrsFromJSON(attrs)
		if err != nil {
			return nil, 0, err
		}
		e.Attributes = m
		out = append(out, IncidentEventView{Event: e, Late: late})
	}
	return out, total, rows.Err()
}

// IncidentCounts implements Store.
func (p *PostgresStore) IncidentCounts(ctx context.Context, now time.Time) (int64, int64, error) {
	var open, last24 int64
	err := p.pool.QueryRow(ctx,
		`SELECT
                   count(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED')),
                   count(*) FILTER (WHERE created_at > $1)
                 FROM incidents`, now.Add(-24*time.Hour)).Scan(&open, &last24)
	return open, last24, err
}

// SetDetectionIncident implements Store.
func (p *PostgresStore) SetDetectionIncident(ctx context.Context, detectionID, incidentID string) error {
	tag, err := p.pool.Exec(ctx, "UPDATE detections SET incident_id=$2 WHERE id=$1", detectionID, incidentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- notes ----

// InsertNote implements Store.
func (p *PostgresStore) InsertNote(ctx context.Context, n *Note) error {
	_, err := p.pool.Exec(ctx,
		"INSERT INTO notes (id, incident_id, author, body, created_at) VALUES ($1,$2,$3,$4,$5)",
		n.ID, n.IncidentID, n.Author, n.Body, n.CreatedAt)
	return err
}

// ListNotes implements Store (oldest first).
func (p *PostgresStore) ListNotes(ctx context.Context, incidentID string) ([]Note, error) {
	rows, err := p.pool.Query(ctx,
		"SELECT id, incident_id, author, body, "+coalesce("created_at")+" FROM notes WHERE incident_id=$1 ORDER BY created_at ASC, id ASC", incidentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.IncidentID, &n.Author, &n.Body, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// ---- ai reports ----

// InsertAIReport implements Store.
func (p *PostgresStore) InsertAIReport(ctx context.Context, ar *AIReport) error {
	_, err := p.pool.Exec(ctx,
		"INSERT INTO ai_reports (id, incident_id, provider_status, ts, report) VALUES ($1,$2,$3,$4,$5)",
		ar.ID, ar.IncidentID, ar.ProviderStatus, ar.TS, []byte(ar.Report))
	return err
}

// ListAIReports implements Store (oldest first).
func (p *PostgresStore) ListAIReports(ctx context.Context, incidentID string) ([]AIReport, error) {
	rows, err := p.pool.Query(ctx,
		"SELECT id, incident_id, provider_status, "+coalesce("ts")+", COALESCE(report,'{}') FROM ai_reports WHERE incident_id=$1 ORDER BY ts ASC, id ASC", incidentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIReport{}
	for rows.Next() {
		var ar AIReport
		var report []byte
		if err := rows.Scan(&ar.ID, &ar.IncidentID, &ar.ProviderStatus, &ar.TS, &report); err != nil {
			return nil, err
		}
		ar.Report = report
		out = append(out, ar)
	}
	return out, rows.Err()
}

// ---- audit ----

// InsertAudit implements Store.
func (p *PostgresStore) InsertAudit(ctx context.Context, a *AuditEntry) error {
	_, err := p.pool.Exec(ctx,
		"INSERT INTO audit_log (id, ts, actor, role, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
		a.ID, a.TS, a.Actor, a.Role, a.Action, a.TargetType, a.TargetID, mustJSON(a.Details))
	return err
}

// ListAudit implements Store (newest first).
func (p *PostgresStore) ListAudit(ctx context.Context, f AuditFilter, page, pageSize int) ([]AuditEntry, int, error) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, arg any) string {
		args = append(args, arg)
		return fmt.Sprintf(format, "$"+fmt.Sprint(len(args)))
	}
	if f.Actor != "" {
		conds = append(conds, add("actor = %s", f.Actor))
	}
	if f.Action != "" {
		conds = append(conds, add("action = %s", f.Action))
	}
	if f.TargetType != "" {
		conds = append(conds, add("target_type = %s", f.TargetType))
	}
	if f.From != nil {
		conds = append(conds, add("ts >= %s", *f.From))
	}
	if f.To != nil {
		conds = append(conds, add("ts <= %s", *f.To))
	}
	where := "WHERE " + strings.Join(conds, " AND ")
	var total int
	if err := p.pool.QueryRow(ctx, "SELECT count(*) FROM audit_log "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 25
	}
	if pageSize > 10000 {
		pageSize = 10000
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := p.pool.Query(ctx,
		"SELECT id, ts, actor, role, action, target_type, target_id, COALESCE(details,'{}'::jsonb) FROM audit_log "+where+" ORDER BY ts DESC, id DESC LIMIT $"+fmt.Sprint(len(args)-1)+" OFFSET $"+fmt.Sprint(len(args)),
		args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]AuditEntry, 0, pageSize)
	for rows.Next() {
		var a AuditEntry
		var details []byte
		if err := rows.Scan(&a.ID, &a.TS, &a.Actor, &a.Role, &a.Action, &a.TargetType, &a.TargetID, &details); err != nil {
			return nil, 0, err
		}
		if err := json.Unmarshal(details, &a.Details); err != nil {
			return nil, 0, err
		}
		if a.Details == nil {
			a.Details = map[string]any{}
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}

// ---- users / sessions / ingest keys ----

// UpsertUser implements Store.
func (p *PostgresStore) UpsertUser(ctx context.Context, u *User) error {
	_, err := p.pool.Exec(ctx,
		`INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (username) DO UPDATE SET password_hash=$2, role=$3, display_name=$4`,
		u.Username, u.PasswordHash, u.Role, u.DisplayName)
	return err
}

// GetUser implements Store.
func (p *PostgresStore) GetUser(ctx context.Context, username string) (*User, error) {
	var u User
	err := p.pool.QueryRow(ctx,
		"SELECT username, password_hash, role, display_name FROM users WHERE username=$1", username).
		Scan(&u.Username, &u.PasswordHash, &u.Role, &u.DisplayName)
	if err != nil {
		return nil, notFound(err)
	}
	return &u, nil
}

// InsertSession implements Store.
func (p *PostgresStore) InsertSession(ctx context.Context, s *Session) error {
	_, err := p.pool.Exec(ctx,
		"INSERT INTO sessions (token, username, expires_at) VALUES ($1,$2,$3)",
		s.Token, s.Username, s.ExpiresAt)
	return err
}

// GetSession implements Store (expired sessions are treated as missing).
func (p *PostgresStore) GetSession(ctx context.Context, token string) (*Session, error) {
	var s Session
	err := p.pool.QueryRow(ctx,
		"SELECT token, username, "+coalesce("expires_at")+" FROM sessions WHERE token=$1 AND expires_at > now()", token).
		Scan(&s.Token, &s.Username, &s.ExpiresAt)
	if err != nil {
		return nil, notFound(err)
	}
	return &s, nil
}

// DeleteSession implements Store.
func (p *PostgresStore) DeleteSession(ctx context.Context, token string) error {
	_, err := p.pool.Exec(ctx, "DELETE FROM sessions WHERE token=$1", token)
	return err
}

// UpsertIngestKey implements Store.
func (p *PostgresStore) UpsertIngestKey(ctx context.Context, k *IngestKey) error {
	_, err := p.pool.Exec(ctx,
		`INSERT INTO ingest_keys (id, value, label, active) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (id) DO UPDATE SET value=$2, label=$3, active=$4`,
		k.ID, k.Value, k.Label, k.Active)
	return dup(err)
}

// GetIngestKey implements Store (lookup by secret value).
func (p *PostgresStore) GetIngestKey(ctx context.Context, value string) (*IngestKey, error) {
	var k IngestKey
	err := p.pool.QueryRow(ctx,
		"SELECT id, value, label, active FROM ingest_keys WHERE value=$1 AND active", value).
		Scan(&k.ID, &k.Value, &k.Label, &k.Active)
	if err != nil {
		return nil, notFound(err)
	}
	return &k, nil
}

// ---- settings & ml ----

// InitSettingsIfAbsent implements Store.
func (p *PostgresStore) InitSettingsIfAbsent(ctx context.Context, s Settings) error {
	_, err := p.pool.Exec(ctx,
		`INSERT INTO settings (id, ai_enabled, ai_provider, correlation_window_seconds, retention_hours, max_batch_size, rate_limit_per_min, language_default)
                 VALUES (1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
		s.AIEnabled, s.AIProvider, s.CorrelationWindowSeconds, s.RetentionHours, s.MaxBatchSize, s.RateLimitPerMin, s.LanguageDefault)
	return err
}

// GetSettings implements Store.
func (p *PostgresStore) GetSettings(ctx context.Context) (Settings, error) {
	var s Settings
	err := p.pool.QueryRow(ctx,
		`SELECT ai_enabled, ai_provider, correlation_window_seconds, retention_hours, max_batch_size, rate_limit_per_min, language_default
                 FROM settings WHERE id=1`).
		Scan(&s.AIEnabled, &s.AIProvider, &s.CorrelationWindowSeconds, &s.RetentionHours, &s.MaxBatchSize, &s.RateLimitPerMin, &s.LanguageDefault)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultSettings(), nil
	}
	if err != nil {
		return Settings{}, err
	}
	return s, nil
}

// SaveSettings implements Store.
func (p *PostgresStore) SaveSettings(ctx context.Context, s Settings) error {
	tag, err := p.pool.Exec(ctx,
		`INSERT INTO settings (id, ai_enabled, ai_provider, correlation_window_seconds, retention_hours, max_batch_size, rate_limit_per_min, language_default)
                 VALUES (1,$1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (id) DO UPDATE SET ai_enabled=$1, ai_provider=$2, correlation_window_seconds=$3,
                   retention_hours=$4, max_batch_size=$5, rate_limit_per_min=$6, language_default=$7`,
		s.AIEnabled, s.AIProvider, s.CorrelationWindowSeconds, s.RetentionHours, s.MaxBatchSize, s.RateLimitPerMin, s.LanguageDefault)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SaveMlRun implements Store.
func (p *PostgresStore) SaveMlRun(ctx context.Context, run *MlRun) error {
	methods := map[string]any{}
	for k, v := range run.Methods {
		methods[k] = v
	}
	info := map[string]any{
		"label":     run.DatasetInfo.Label,
		"anomalies": run.DatasetInfo.Anomalies,
		"normal":    run.DatasetInfo.Normal,
	}
	_, err := p.pool.Exec(ctx,
		"INSERT INTO ml_runs (ts, seed, dataset_size, methods, dataset_info) VALUES ($1,$2,$3,$4,$5)",
		run.TS, run.Seed, run.DatasetSize, mustJSON(methods), mustJSON(info))
	return err
}

// LastMlRun implements Store.
func (p *PostgresStore) LastMlRun(ctx context.Context) (*MlRun, error) {
	var run MlRun
	var methods, info []byte
	err := p.pool.QueryRow(ctx,
		`SELECT `+coalesce("ts")+`, seed, dataset_size, COALESCE(methods,'{}'::jsonb), COALESCE(dataset_info,'{}'::jsonb)
                 FROM ml_runs ORDER BY id DESC LIMIT 1`).
		Scan(&run.TS, &run.Seed, &run.DatasetSize, &methods, &info)
	if err != nil {
		return nil, notFound(err)
	}
	if err := json.Unmarshal(methods, &run.Methods); err != nil {
		return nil, err
	}
	if run.Methods == nil {
		run.Methods = map[string]MlMethodMetrics{}
	}
	var w struct {
		Label     string `json:"label"`
		Anomalies int    `json:"anomalies"`
		Normal    int    `json:"normal"`
	}
	if err := json.Unmarshal(info, &w); err == nil {
		run.DatasetInfo.Label = w.Label
		run.DatasetInfo.Anomalies = w.Anomalies
		run.DatasetInfo.Normal = w.Normal
	}
	return &run, nil
}

// ---- demo reset ----

// ResetDemoData implements Store: wipes events, detections, incidents,
// notes, ai reports, validation failures and the audit trail; keeps users,
// rules, settings and ingest keys.
func (p *PostgresStore) ResetDemoData(ctx context.Context) error {
	stmts := []string{
		"DELETE FROM incident_events",
		"DELETE FROM notes",
		"DELETE FROM ai_reports",
		"DELETE FROM incidents",
		"DELETE FROM detections",
		"DELETE FROM events",
		"DELETE FROM validation_failures",
		"DELETE FROM audit_log",
		"DELETE FROM ml_runs",
		"ALTER SEQUENCE incident_seq RESTART WITH 1",
	}
	for _, s := range stmts {
		if _, err := p.pool.Exec(ctx, s); err != nil {
			return fmt.Errorf("reset: %s: %w", s[:24], err)
		}
	}
	return nil
}
