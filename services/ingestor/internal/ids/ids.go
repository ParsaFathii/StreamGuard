// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package ids provides small random identifier helpers (crypto/rand based).
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// NewUUID returns a random RFC 4122 version-4 UUID string.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand never fails on supported platforms; fall back to a
		// clearly-marked pseudo id rather than panicking.
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]))
}

// NewToken returns a 32-byte random hex token (used for session tokens).
func NewToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

// New returns a prefixed identifier, e.g. New("DET") -> "DET-<uuid>".
func New(prefix string) string { return prefix + "-" + NewUUID() }
