// Copyright © 2026 Parsa Fathi — Apache-2.0

package config

import (
        "strings"
        "testing"
)

func setenvs(t *testing.T, kv map[string]string) {
        t.Helper()
        for k, v := range kv {
                t.Setenv(k, v)
        }
}

func TestDefaults(t *testing.T) {
        setenvs(t, map[string]string{
                "PORT": "", "POSTGRES_DSN": "", "SESSION_SECRET": "0123456789abcdef0123456789abcdef",
                "INGEST_KEY": "", "RATE_LIMIT_PER_MIN": "", "MAX_BATCH": "", "RETENTION_HOURS": "",
                "CORRELATION_WINDOW_SECONDS": "", "LLM_BASE_URL": "", "LLM_MODEL": "",
        })
        c, err := Load()
        if err != nil {
                t.Fatalf("Load: %v", err)
        }
        if c.Port != 8080 || c.RateLimitPerMin != 60 || c.MaxBatch != 100 ||
                c.RetentionHours != 72 || c.CorrelationWindowSeconds != 600 {
                t.Fatalf("unexpected defaults: %+v", c)
        }
        if c.PostgresDSN != "" {
                t.Fatalf("expected empty DSN -> memory store")
        }
        if c.LLMBaseURL != "http://127.0.0.1:11434" || c.LLMModel != "llama3.2" {
                t.Fatalf("unexpected llm defaults: %s %s", c.LLMBaseURL, c.LLMModel)
        }
        if !c.defaultIngestKey {
                t.Fatalf("expected default ingest key marker")
        }
}

func TestEphemeralSecretGenerated(t *testing.T) {
        setenvs(t, map[string]string{"SESSION_SECRET": "", "INGEST_KEY": "k123"})
        c, err := Load()
        if err != nil {
                t.Fatalf("Load: %v", err)
        }
        if len(c.SessionSecret) < 32 {
                t.Fatalf("ephemeral secret too short")
        }
        if !c.ephemeralSecret {
                t.Fatalf("expected ephemeralSecret marker")
        }
}

func TestValidationErrors(t *testing.T) {
        cases := []struct {
                name string
                env  map[string]string
                want string
        }{
                {"bad port", map[string]string{"PORT": "99999", "SESSION_SECRET": "0123456789abcdef", "INGEST_KEY": "k"}, "PORT"},
                {"rate limit zero", map[string]string{"RATE_LIMIT_PER_MIN": "0", "SESSION_SECRET": "0123456789abcdef", "INGEST_KEY": "k"}, "RATE_LIMIT_PER_MIN"},
                {"max batch huge", map[string]string{"MAX_BATCH": "5000", "SESSION_SECRET": "0123456789abcdef", "INGEST_KEY": "k"}, "MAX_BATCH"},
                {"retention zero", map[string]string{"RETENTION_HOURS": "0", "SESSION_SECRET": "0123456789abcdef", "INGEST_KEY": "k"}, "RETENTION_HOURS"},
                {"window too small", map[string]string{"CORRELATION_WINDOW_SECONDS": "1", "SESSION_SECRET": "0123456789abcdef", "INGEST_KEY": "k"}, "CORRELATION_WINDOW_SECONDS"},
                {"empty ingest key falls back to default", map[string]string{"INGEST_KEY": "", "SESSION_SECRET": "0123456789abcdef"}, ""},
        }
        for _, tc := range cases {
                t.Run(tc.name, func(t *testing.T) {
                        setenvs(t, tc.env)
                        c, err := Load()
                        if tc.want == "" {
                                // fallback-to-default case: no error, default key marker set
                                if err != nil {
                                        t.Fatalf("unexpected error: %v", err)
                                }
                                if !c.defaultIngestKey {
                                        t.Fatalf("expected default ingest key fallback")
                                }
                                return
                        }
                        if err == nil {
                                t.Fatalf("expected error containing %q, got nil", tc.want)
                        }
                        if !strings.Contains(err.Error(), tc.want) {
                                t.Fatalf("error %q does not mention %q", err, tc.want)
                        }
                })
        }
}

func TestRedactedHidesSecrets(t *testing.T) {
        setenvs(t, map[string]string{
                "SESSION_SECRET": "super-secret-value-do-not-log",
                "INGEST_KEY":     "super-ingest-key-do-not-log",
                "POSTGRES_DSN":   "postgres://u:hunter2@db:5432/x",
        })
        c, err := Load()
        if err != nil {
                t.Fatalf("Load: %v", err)
        }
        r := c.Redacted()
        for _, secret := range []string{"super-secret-value-do-not-log", "super-ingest-key-do-not-log", "hunter2"} {
                if strings.Contains(r, secret) {
                        t.Fatalf("Redacted() leaked %q: %s", secret, r)
                }
        }
        if !strings.Contains(r, "store=postgres") {
                t.Fatalf("expected store=postgres in %s", r)
        }
        // no DSN set -> memory store marker
        setenvs(t, map[string]string{"POSTGRES_DSN": ""})
        c2, err := Load()
        if err != nil {
                t.Fatalf("Load: %v", err)
        }
        if !strings.Contains(c2.Redacted(), "store=memory") {
                t.Fatalf("expected store=memory")
        }
}
