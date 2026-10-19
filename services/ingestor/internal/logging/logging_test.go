// Copyright © 2026 Parsa Fathi — Apache-2.0

package logging

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestJSONShapeAndRedaction(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, "debug")
	l.Info("request done",
		"method", "POST",
		"authorization", "Bearer super-secret-token",
		"cookie", "sg_session=abc123",
		"x-ingest-key", "k-topsecret",
		"path", "/api/ingest",
	)
	line := buf.String()
	if !strings.HasPrefix(line, "{") || !strings.HasSuffix(strings.TrimSpace(line), "}") {
		t.Fatalf("not a JSON line: %q", line)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for k, want := range map[string]string{
		"level": "info", "msg": "request done", "method": "POST", "path": "/api/ingest",
	} {
		if m[k] != want {
			t.Fatalf("field %s = %v, want %q", k, m[k], want)
		}
	}
	for _, k := range []string{"authorization", "cookie", "x-ingest-key"} {
		if m[k] != "[REDACTED]" {
			t.Fatalf("field %s = %v, want [REDACTED]", k, m[k])
		}
	}
	if strings.Contains(line, "super-secret-token") || strings.Contains(line, "k-topsecret") {
		t.Fatalf("secrets leaked: %s", line)
	}
	if _, ok := m["ts"]; !ok {
		t.Fatalf("missing ts field")
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, "warn")
	l.Debug("d")
	l.Info("i")
	l.Warn("w")
	l.Error("e")
	lines := strings.Count(buf.String(), "\n")
	if lines != 2 {
		t.Fatalf("expected 2 lines (warn+error), got %d: %q", lines, buf.String())
	}
}

func TestBoundedFields(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, "debug")
	kv := make([]any, 0, 100)
	for i := 0; i < 50; i++ {
		kv = append(kv, "k", i)
	}
	l.Info("many", kv...)
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// level+ts+msg + at most maxFields
	if len(m) > 3+maxFields {
		t.Fatalf("unbounded fields: %d", len(m))
	}
}

func TestIsSensitive(t *testing.T) {
	for _, k := range []string{"Authorization", "COOKIE", "X-Ingest-Key", "password"} {
		if !IsSensitive(k) {
			t.Fatalf("%q should be sensitive", k)
		}
	}
	for _, k := range []string{"method", "path", "status"} {
		if IsSensitive(k) {
			t.Fatalf("%q should not be sensitive", k)
		}
	}
}
