// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package logging implements minimal structured JSON logging with secret
// redaction for sensitive keys (authorization headers, cookies, ingest keys,
// passwords, DSNs). Line volume is bounded by design: request logs carry a
// fixed, small field set.
package logging

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"time"
)

// Level is a log severity.
type Level int

// Levels in increasing order of severity.
const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

func parseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

// maxFields bounds the number of structured fields per line so a caller bug
// cannot produce unbounded log lines.
const maxFields = 16

// sensitiveKeys are field keys whose values must never be logged.
var sensitiveKeys = map[string]bool{
	"authorization":    true,
	"cookie":           true,
	"x-ingest-key":     true,
	"ingest_key":       true,
	"ingestkey":        true,
	"password":         true,
	"session_secret":   true,
	"sessionsecret":    true,
	"secret":           true,
	"token":            true,
	"postgres_dsn":     true,
	"dsn":              true,
	"set-cookie":       true,
	"sg_session":       true,
	"x-session-token":  true,
	"password_hash":    true,
	"apikey":           true,
	"api_key":          true,
}

// IsSensitive reports whether a field key is considered a secret.
func IsSensitive(key string) bool { return sensitiveKeys[strings.ToLower(strings.TrimSpace(key))] }

// Redacted replaces the value of sensitive keys with [REDACTED].
func Redacted(kv map[string]any) map[string]any {
	out := make(map[string]any, len(kv))
	for k, v := range kv {
		if IsSensitive(k) {
			out[k] = "[REDACTED]"
			continue
		}
		if IsSensitive(fmtString(v)) {
			out[k] = "[REDACTED]"
			continue
		}
		out[k] = v
	}
	return out
}

func fmtString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// Logger writes structured JSON log lines to an io.Writer.
type Logger struct {
	mu  sync.Mutex
	w   io.Writer
	min Level
	now func() time.Time
}

// New creates a Logger writing to w at the given minimum level
// ("debug"|"info"|"warn"|"error"; default info).
func New(w io.Writer, minLevel string) *Logger {
	return &Logger{w: w, min: parseLevel(minLevel), now: time.Now}
}

// Enabled reports whether the given level would be emitted.
func (l *Logger) Enabled(lv Level) bool { return lv >= l.min }

func (l *Logger) log(lv Level, msg string, kv ...any) {
	if l == nil || l.w == nil || lv < l.min {
		return
	}
	entry := make(map[string]any, 4+len(kv)/2)
	entry["level"] = lv.String()
	entry["ts"] = l.now().UTC().Format(time.RFC3339Nano)
	entry["msg"] = msg
	n := 0
	for i := 0; i+1 < len(kv) && n < maxFields; i += 2 {
		key, ok := kv[i].(string)
		if !ok || key == "" {
			continue
		}
		if IsSensitive(key) {
			entry[key] = "[REDACTED]"
		} else {
			entry[key] = kv[i+1]
		}
		n++
	}
	b, err := json.Marshal(entry)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(append(b, '\n'))
}

// Debug logs at debug level.
func (l *Logger) Debug(msg string, kv ...any) { l.log(LevelDebug, msg, kv...) }

// Info logs at info level.
func (l *Logger) Info(msg string, kv ...any) { l.log(LevelInfo, msg, kv...) }

// Warn logs at warn level.
func (l *Logger) Warn(msg string, kv ...any) { l.log(LevelWarn, msg, kv...) }

// Error logs at error level.
func (l *Logger) Error(msg string, kv ...any) { l.log(LevelError, msg, kv...) }

// Discard returns a logger that drops everything (for tests).
func Discard() *Logger { return New(io.Discard, "error") }
