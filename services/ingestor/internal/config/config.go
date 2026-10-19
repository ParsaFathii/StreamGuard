// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package config loads, validates and safely renders service configuration
// from environment variables. Secrets are never logged in clear text.
package config

import (
        "crypto/rand"
        "encoding/hex"
        "errors"
        "fmt"
        "os"
        "strconv"
        "strings"
)

// Version is the StreamGuard product version surfaced via
// X-StreamGuard-Version and /api/health.
const Version = "10.4.0"

// Config holds all runtime configuration for the ingestor service.
type Config struct {
        Port                      int    // PORT (default 8080)
        PostgresDSN               string // POSTGRES_DSN (empty -> in-memory store)
        SessionSecret             string // SESSION_SECRET (default: random, sessions non-durable across restarts)
        IngestKey                 string // INGEST_KEY value for seeded ingest key id "demo-key-01"
        AnalyticsURL              string // ANALYTICS_URL (optional, reserved)
        RateLimitPerMin           int    // RATE_LIMIT_PER_MIN (default 60)
        MaxBatch                  int    // MAX_BATCH (default 100)
        RetentionHours            int    // RETENTION_HOURS (default 72)
        CorrelationWindowSeconds  int    // CORRELATION_WINDOW_SECONDS (default 600)
        LLMBaseURL                string // LLM_BASE_URL (default http://127.0.0.1:11434)
        LLMModel                  string // LLM_MODEL (default llama3.2)
        LLMTimeoutSeconds         int    // LLM_TIMEOUT (default 45; per-request LLM call budget)

        // diagnostics only (used by Redacted, never expose values)
        ephemeralSecret   bool
        defaultIngestKey  bool
}

// Load reads the environment, applies safe defaults and validates the result.
func Load() (*Config, error) {
        c := &Config{
                Port:                     envInt("PORT", 8080),
                PostgresDSN:              strings.TrimSpace(os.Getenv("POSTGRES_DSN")),
                SessionSecret:            os.Getenv("SESSION_SECRET"),
                IngestKey:                os.Getenv("INGEST_KEY"),
                AnalyticsURL:             strings.TrimSpace(os.Getenv("ANALYTICS_URL")),
                RateLimitPerMin:          envInt("RATE_LIMIT_PER_MIN", 60),
                MaxBatch:                 envInt("MAX_BATCH", 100),
                RetentionHours:           envInt("RETENTION_HOURS", 72),
                CorrelationWindowSeconds: envInt("CORRELATION_WINDOW_SECONDS", 600),
                LLMBaseURL:               strings.TrimSpace(os.Getenv("LLM_BASE_URL")),
                LLMModel:                 strings.TrimSpace(os.Getenv("LLM_MODEL")),
                LLMTimeoutSeconds:        envInt("LLM_TIMEOUT", 45),
        }
        if c.SessionSecret == "" {
                // Generate an ephemeral secret; sessions will not survive restarts
                // (documented). Never log the value itself.
                var b [32]byte
                if _, err := rand.Read(b[:]); err != nil {
                        return nil, fmt.Errorf("generate session secret: %w", err)
                }
                c.SessionSecret = hex.EncodeToString(b[:])
                c.ephemeralSecret = true
        }
        if c.IngestKey == "" {
                // Demo ingest key value (key id: demo-key-01). Change INGEST_KEY in
                // any real deployment.
                c.IngestKey = "sg-demo-ingest-key-2026"
                c.defaultIngestKey = true
        }
        if c.LLMBaseURL == "" {
                c.LLMBaseURL = "http://127.0.0.1:11434"
        }
        if c.LLMModel == "" {
                c.LLMModel = "llama3.2"
        }
        if err := c.Validate(); err != nil {
                return nil, err
        }
        return c, nil
}

// Validate enforces safe ranges for every knob.
func (c *Config) Validate() error {
        var errs []error
        if c.Port < 1 || c.Port > 65535 {
                errs = append(errs, fmt.Errorf("PORT must be in 1..65535, got %d", c.Port))
        }
        if c.RateLimitPerMin < 1 || c.RateLimitPerMin > 100000 {
                errs = append(errs, fmt.Errorf("RATE_LIMIT_PER_MIN must be in 1..100000, got %d", c.RateLimitPerMin))
        }
        if c.MaxBatch < 1 || c.MaxBatch > 1000 {
                errs = append(errs, fmt.Errorf("MAX_BATCH must be in 1..1000, got %d", c.MaxBatch))
        }
        if c.RetentionHours < 1 || c.RetentionHours > 24*365 {
                errs = append(errs, fmt.Errorf("RETENTION_HOURS must be in 1..8760, got %d", c.RetentionHours))
        }
        if c.CorrelationWindowSeconds < 10 || c.CorrelationWindowSeconds > 86400 {
                errs = append(errs, fmt.Errorf("CORRELATION_WINDOW_SECONDS must be in 10..86400, got %d", c.CorrelationWindowSeconds))
        }
        if len(c.SessionSecret) < 16 {
                errs = append(errs, errors.New("SESSION_SECRET must be at least 16 characters"))
        }
        if c.IngestKey == "" {
                errs = append(errs, errors.New("INGEST_KEY must not be empty"))
        }
        if c.LLMBaseURL == "" || !strings.HasPrefix(c.LLMBaseURL, "http://") && !strings.HasPrefix(c.LLMBaseURL, "https://") {
                errs = append(errs, errors.New("LLM_BASE_URL must be an http(s) URL"))
        }
        if c.LLMModel == "" {
                errs = append(errs, errors.New("LLM_MODEL must not be empty"))
        }
        if len(errs) == 1 {
                return errs[0]
        }
        if len(errs) > 1 {
                return fmt.Errorf("invalid configuration: %v", errs)
        }
        return nil
}

// Redacted returns a human-readable, secret-free rendering for startup logs.
func (c *Config) Redacted() string {
        secret := "set"
        if c.ephemeralSecret {
                secret = "generated-ephemeral"
        }
        key := "set"
        if c.defaultIngestKey {
                key = "default-demo-value (change INGEST_KEY!)"
        }
        return fmt.Sprintf(
                "config{port=%d store=%s session_secret=%s ingest_key=%s analytics_url=%s rate_limit_per_min=%d max_batch=%d retention_hours=%d correlation_window_seconds=%d llm_base_url=%s llm_model=%s}",
                c.Port, storeKind(c.PostgresDSN), secret, key, orDash(c.AnalyticsURL),
                c.RateLimitPerMin, c.MaxBatch, c.RetentionHours, c.CorrelationWindowSeconds,
                c.LLMBaseURL, c.LLMModel,
        )
}

func storeKind(dsn string) string {
        if dsn == "" {
                return "memory"
        }
        return "postgres"
}

func orDash(s string) string {
        if s == "" {
                return "-"
        }
        return s
}

func envInt(name string, def int) int {
        raw := strings.TrimSpace(os.Getenv(name))
        if raw == "" {
                return def
        }
        v, err := strconv.Atoi(raw)
        if err != nil {
                return def
        }
        return v
}
