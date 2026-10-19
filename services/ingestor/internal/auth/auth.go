// Copyright © 2026 Parsa Fathii — Apache-2.0

// Package auth implements session auth (crypto/rand tokens, HMAC-signed
// sg_session cookie, bcrypt passwords), the seeded demo users, ingest-key
// auth (X-Ingest-Key) and a sliding-window rate limiter.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/ids"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// CookieName is the session cookie name.
const CookieName = "sg_session"

// SessionTTL is how long sessions live.
const SessionTTL = 24 * time.Hour

// ErrUnauthorized is returned when credentials are missing or invalid.
var ErrUnauthorized = errors.New("unauthorized")

// ErrInvalidCredentials is returned on wrong username/password.
var ErrInvalidCredentials = errors.New("invalid username or password")

// SeedUser describes a seeded demo user.
type SeedUser struct {
	Username, Password, Role, DisplayName string
}

// SeedUsers are the contract demo users.
var SeedUsers = []SeedUser{
	{Username: "admin", Password: "admin123", Role: "ADMIN", DisplayName: "Administrator"},
	{Username: "analyst", Password: "analyst123", Role: "ANALYST", DisplayName: "Analyst"},
	{Username: "viewer", Password: "viewer123", Role: "VIEWER", DisplayName: "Viewer"},
}

// hashCache caches bcrypt hashes of seed users so repeated test seeding is
// fast (bcrypt is deliberately expensive).
var hashCache struct {
	once   sync.Once
	hashes map[string]string // username -> hash
}

func seedHash(u SeedUser) string {
	hashCache.once.Do(func() { hashCache.hashes = make(map[string]string) })
	if h, ok := hashCache.hashes[u.Username]; ok {
		return h
	}
	// bcrypt generates a random salt; cache the first one produced.
	h, err := bcrypt.GenerateFromPassword([]byte(u.Password), bcrypt.DefaultCost)
	if err != nil {
		panic("bcrypt: " + err.Error())
	}
	hashCache.hashes[u.Username] = string(h)
	return string(h)
}

// Service provides authentication.
type Service struct {
	st      store.Store
	secret  []byte
	limiter *RateLimiter
}

// NewService creates the auth service. rateLimitPerMin is read dynamically
// so settings changes take effect without restart.
func NewService(st store.Store, secret []byte, rateLimitPerMin func() int) *Service {
	if rateLimitPerMin == nil {
		rateLimitPerMin = func() int { return 60 }
	}
	return &Service{st: st, secret: secret, limiter: NewRateLimiter(rateLimitPerMin)}
}

// SeedUsersIntoStore inserts the demo users (idempotent per username).
func (s *Service) SeedUsersIntoStore(ctx context.Context) error {
	for _, u := range SeedUsers {
		if err := s.st.UpsertUser(ctx, &store.User{
			Username: u.Username, PasswordHash: seedHash(u), Role: u.Role, DisplayName: u.DisplayName,
		}); err != nil {
			return err
		}
	}
	return nil
}

// Login verifies credentials and creates a session.
func (s *Service) Login(ctx context.Context, username, password string) (*store.Session, *store.User, error) {
	u, err := s.st.GetUser(ctx, username)
	if err != nil {
		// Constant-ish time: still run a bcrypt compare against a dummy hash.
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5B0X0wJk9yGKQGmYt0/8UOgD1B7fW"), []byte(password))
		return nil, nil, ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)); err != nil {
		return nil, nil, ErrInvalidCredentials
	}
	tok := ids.NewToken()
	if tok == "" {
		return nil, nil, errors.New("token generation failed")
	}
	sess := &store.Session{Token: tok, Username: username, ExpiresAt: time.Now().Add(SessionTTL)}
	if err := s.st.InsertSession(ctx, sess); err != nil {
		return nil, nil, err
	}
	return sess, u, nil
}

// Logout deletes the session.
func (s *Service) Logout(ctx context.Context, token string) error {
	return s.st.DeleteSession(ctx, token)
}

// ---- cookie signing ----

func (s *Service) sign(token string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(token))
	return hex.EncodeToString(mac.Sum(nil))
}

// SessionCookie returns the signed HttpOnly session cookie.
func (s *Service) SessionCookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    token + "." + s.sign(token),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(SessionTTL.Seconds()),
	}
}

// ClearCookie returns an expiring cookie.
func (s *Service) ClearCookie() *http.Cookie {
	return &http.Cookie{Name: CookieName, Value: "", Path: "/", HttpOnly: true, MaxAge: -1}
}

// parseSigned splits "token.sig" and verifies the HMAC.
func (s *Service) parseSigned(v string) (string, bool) {
	idx := strings.LastIndex(v, ".")
	if idx <= 0 {
		return "", false
	}
	token, sig := v[:idx], v[idx+1:]
	want := s.sign(token)
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return "", false
	}
	return token, true
}

// Authenticate resolves the request's session (cookie or Bearer token) to a
// user. Returns ErrUnauthorized when absent/invalid/expired.
func (s *Service) Authenticate(ctx context.Context, r *http.Request) (*store.Session, *store.User, error) {
	token := ""
	if c, err := r.Cookie(CookieName); err == nil {
		if t, ok := s.parseSigned(c.Value); ok {
			token = t
		}
	}
	if token == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			token = strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
			// Bearer may carry either the raw token or the signed cookie value.
			if t, ok := s.parseSigned(token); ok {
				token = t
			}
		}
	}
	if token == "" {
		return nil, nil, ErrUnauthorized
	}
	sess, err := s.st.GetSession(ctx, token)
	if err != nil {
		return nil, nil, ErrUnauthorized
	}
	u, err := s.st.GetUser(ctx, sess.Username)
	if err != nil {
		return nil, nil, ErrUnauthorized
	}
	return sess, u, nil
}

// AuthenticateIngestKey validates the X-Ingest-Key header.
func (s *Service) AuthenticateIngestKey(ctx context.Context, r *http.Request) (*store.IngestKey, error) {
	v := strings.TrimSpace(r.Header.Get("X-Ingest-Key"))
	if v == "" {
		return nil, ErrUnauthorized
	}
	k, err := s.st.GetIngestKey(ctx, v)
	if err != nil {
		return nil, ErrUnauthorized
	}
	return k, nil
}

// AllowIngest applies the per-principal sliding window rate limit.
func (s *Service) AllowIngest(principal string) (bool, time.Duration) {
	return s.limiter.Allow(principal)
}

// RateLimiter is a sliding-window limiter (window 1 minute).
type RateLimiter struct {
	mu    sync.Mutex
	hits  map[string][]time.Time
	limit func() int
}

// NewRateLimiter creates a limiter; limit is read per call.
func NewRateLimiter(limit func() int) *RateLimiter {
	return &RateLimiter{hits: make(map[string][]time.Time), limit: limit}
}

// Allow reports whether the key is within the window; when denied it returns
// how long to wait.
func (l *RateLimiter) Allow(key string) (bool, time.Duration) {
	now := time.Now()
	window := time.Minute
	l.mu.Lock()
	defer l.mu.Unlock()
	hits := l.hits[key]
	kept := hits[:0]
	for _, t := range hits {
		if now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	limit := l.limit()
	if len(kept) >= limit {
		l.hits[key] = kept
		retry := window - now.Sub(kept[0])
		if retry < time.Second {
			retry = time.Second
		}
		return false, retry
	}
	kept = append(kept, now)
	l.hits[key] = kept
	// bounded map: opportunistic cleanup
	if len(l.hits) > 4096 {
		for k, v := range l.hits {
			if len(v) == 0 || now.Sub(v[len(v)-1]) >= window {
				delete(l.hits, k)
			}
		}
	}
	return true, 0
}

// SortedHitCount returns the number of current hits for a key (tests).
func (l *RateLimiter) SortedHitCount(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.hits[key])
}

// Ensure sorts a slice of times ascending (test helper kept tiny).
func Ensure(ts []time.Time) { sort.Slice(ts, func(i, j int) bool { return ts[i].Before(ts[j]) }) }

// NewToken exposes token generation for tests.
func NewToken() string { return ids.NewToken() }

// RandomBytes is used by tests to ensure crypto/rand works.
func RandomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil
	}
	return b
}
