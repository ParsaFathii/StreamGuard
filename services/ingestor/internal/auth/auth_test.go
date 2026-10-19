// Copyright © 2026 Parsa Fathi — Apache-2.0

package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

func newService(t *testing.T) *Service {
	t.Helper()
	st := store.NewMemStore()
	s := NewService(st, []byte("test-secret-0123456789abcdef"), func() int { return 60 })
	if err := s.SeedUsersIntoStore(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestLoginHappyPath(t *testing.T) {
	s := newService(t)
	sess, u, err := s.Login(context.Background(), "admin", "admin123")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if sess.Token == "" || len(sess.Token) != 64 {
		t.Fatalf("bad token: %q", sess.Token)
	}
	if u.Role != "ADMIN" || u.DisplayName != "Administrator" {
		t.Fatalf("bad user: %+v", u)
	}
	if !sess.ExpiresAt.After(time.Now()) {
		t.Fatalf("session must expire in the future")
	}
}

func TestLoginWrongPasswordAndUnknownUser(t *testing.T) {
	s := newService(t)
	if _, _, err := s.Login(context.Background(), "admin", "wrong"); err != ErrInvalidCredentials {
		t.Fatalf("want ErrInvalidCredentials, got %v", err)
	}
	if _, _, err := s.Login(context.Background(), "ghost", "whatever"); err != ErrInvalidCredentials {
		t.Fatalf("unknown user must also return ErrInvalidCredentials (no user enumeration), got %v", err)
	}
}

func TestCookieSignVerify(t *testing.T) {
	s := newService(t)
	sess, _, _ := s.Login(context.Background(), "analyst", "analyst123")
	cookie := s.SessionCookie(sess.Token)
	if !cookie.HttpOnly || cookie.Name != "sg_session" || cookie.Path != "/" {
		t.Fatalf("bad cookie: %+v", cookie)
	}

	mkReq := func(cookieVal string) *http.Request {
		r := httptest.NewRequest("GET", "/api/auth/session", nil)
		r.AddCookie(&http.Cookie{Name: CookieName, Value: cookieVal})
		return r
	}
	// valid cookie authenticates
	got, u, err := s.Authenticate(context.Background(), mkReq(cookie.Value))
	if err != nil || got.Token != sess.Token || u.Username != "analyst" {
		t.Fatalf("authenticate: %v", err)
	}
	// tampered signature fails
	if _, _, err := s.Authenticate(context.Background(), mkReq(sess.Token+".deadbeef")); err != ErrUnauthorized {
		t.Fatalf("tampered cookie must be rejected, got %v", err)
	}
	// unknown token fails
	if _, _, err := s.Authenticate(context.Background(), mkReq("f00baa."+s.sign("f00baa"))); err != ErrUnauthorized {
		t.Fatalf("unknown token must be rejected")
	}
	// no cookie fails
	if _, _, err := s.Authenticate(context.Background(), httptest.NewRequest("GET", "/", nil)); err != ErrUnauthorized {
		t.Fatalf("no cookie must be unauthorized")
	}
}

func TestBearerToken(t *testing.T) {
	s := newService(t)
	sess, _, _ := s.Login(context.Background(), "viewer", "viewer123")
	r := httptest.NewRequest("GET", "/api/events", nil)
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	if _, u, err := s.Authenticate(context.Background(), r); err != nil || u.Username != "viewer" {
		t.Fatalf("bearer auth failed: %v", err)
	}
	// signed cookie value in bearer also works
	r2 := httptest.NewRequest("GET", "/api/events", nil)
	r2.Header.Set("Authorization", "Bearer "+s.SessionCookie(sess.Token).Value)
	if _, _, err := s.Authenticate(context.Background(), r2); err != nil {
		t.Fatalf("signed bearer failed: %v", err)
	}
}

func TestExpiredSession(t *testing.T) {
	st := store.NewMemStore()
	s := NewService(st, []byte("test-secret-0123456789abcdef"), nil)
	if err := s.SeedUsersIntoStore(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Insert an already-expired session directly.
	if err := st.InsertSession(context.Background(), &store.Session{
		Token: "expired-token", Username: "admin", ExpiresAt: time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/api/auth/session", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "expired-token." + s.sign("expired-token")})
	if _, _, err := s.Authenticate(context.Background(), r); err != ErrUnauthorized {
		t.Fatalf("expired session must be unauthorized, got %v", err)
	}
}

func TestLogout(t *testing.T) {
	s := newService(t)
	sess, _, _ := s.Login(context.Background(), "admin", "admin123")
	if err := s.Logout(context.Background(), sess.Token); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	if _, _, err := s.Authenticate(context.Background(), r); err != ErrUnauthorized {
		t.Fatalf("logged out session must not authenticate")
	}
}

func TestIngestKeyAuth(t *testing.T) {
	st := store.NewMemStore()
	s := NewService(st, []byte("test-secret-0123456789abcdef"), nil)
	if err := st.UpsertIngestKey(context.Background(), &store.IngestKey{ID: "demo-key-01", Value: "k1", Active: true}); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/ingest", nil)
	r.Header.Set("X-Ingest-Key", "k1")
	if k, err := s.AuthenticateIngestKey(context.Background(), r); err != nil || k.ID != "demo-key-01" {
		t.Fatalf("ingest key: %v", err)
	}
	r2 := httptest.NewRequest("POST", "/api/ingest", nil)
	if _, err := s.AuthenticateIngestKey(context.Background(), r2); err != ErrUnauthorized {
		t.Fatalf("missing key must be unauthorized")
	}
	r3 := httptest.NewRequest("POST", "/api/ingest", nil)
	r3.Header.Set("X-Ingest-Key", "wrong")
	if _, err := s.AuthenticateIngestKey(context.Background(), r3); err != ErrUnauthorized {
		t.Fatalf("wrong key must be unauthorized")
	}
	// inactive key rejected
	_ = st.UpsertIngestKey(context.Background(), &store.IngestKey{ID: "off", Value: "k2", Active: false})
	r4 := httptest.NewRequest("POST", "/api/ingest", nil)
	r4.Header.Set("X-Ingest-Key", "k2")
	if _, err := s.AuthenticateIngestKey(context.Background(), r4); err != ErrUnauthorized {
		t.Fatalf("inactive key must be unauthorized")
	}
}

func TestRateLimiterSlidingWindow(t *testing.T) {
	limit := 3
	l := NewRateLimiter(func() int { return limit })
	for i := 0; i < limit; i++ {
		if ok, _ := l.Allow("k"); !ok {
			t.Fatalf("request %d should be allowed", i)
		}
	}
	ok, retry := l.Allow("k")
	if ok || retry <= 0 {
		t.Fatalf("request beyond limit must be denied with retry-after")
	}
	// other keys unaffected
	if ok, _ := l.Allow("other"); !ok {
		t.Fatalf("other key must be allowed")
	}
	// simulate window slide: oldest hit expires
	l.mu.Lock()
	l.hits["k"][0] = time.Now().Add(-2 * time.Minute)
	l.mu.Unlock()
	if ok, _ := l.Allow("k"); !ok {
		t.Fatalf("after window slides the key must be allowed again")
	}
}

func TestRateLimiterDynamicLimit(t *testing.T) {
	n := 5
	l := NewRateLimiter(func() int { return n })
	for i := 0; i < 5; i++ {
		l.Allow("k")
	}
	if ok, _ := l.Allow("k"); ok {
		t.Fatalf("denied at limit 5")
	}
	n = 10 // settings change takes effect
	if ok, _ := l.Allow("k"); !ok {
		t.Fatalf("allowed after limit raised")
	}
}

func TestSeedHashCache(t *testing.T) {
	h1 := seedHash(SeedUsers[0])
	h2 := seedHash(SeedUsers[0])
	if h1 != h2 {
		t.Fatalf("hash cache not stable")
	}
	if len(h1) < 20 {
		t.Fatalf("bad hash")
	}
}

func TestServiceAllowIngest(t *testing.T) {
	s := newService(t)
	for i := 0; i < 60; i++ {
		ok, _ := s.AllowIngest("key:demo-key-01")
		if !ok {
			t.Fatalf("request %d should pass at limit 60", i)
		}
	}
	ok, retry := s.AllowIngest("key:demo-key-01")
	if ok || retry <= 0 {
		t.Fatalf("61st request must be rate limited")
	}
}
