// Copyright © 2026 Parsa Fathi — Apache-2.0

// Auth handlers: login (audited), logout (audited), session.
package api

import (
	"net/http"
	"strings"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/auth"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

type loginBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// handleLogin implements POST /api/auth/login.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body loginBody
	if !s.decodeJSON(w, r, &body) {
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" {
		badRequest(w, "MISSING_FIELD", "username is required")
		return
	}
	if body.Password == "" {
		badRequest(w, "MISSING_FIELD", "password is required")
		return
	}
	sess, user, err := s.auth.Login(r.Context(), body.Username, body.Password)
	if err == auth.ErrInvalidCredentials {
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "invalid username or password")
		return
	}
	if err != nil {
		s.internalError(w, r, "login", err)
		return
	}
	http.SetCookie(w, s.auth.SessionCookie(sess.Token))
	s.auditRaw(user.Username, user.Role, "login", "session", user.Username, map[string]any{"ok": true})
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{
			"username":    user.Username,
			"role":        user.Role,
			"displayName": user.DisplayName,
		},
	})
}

// handleLogout implements POST /api/auth/logout (audited).
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, sess *store.Session, user *store.User) {
	if err := s.auth.Logout(r.Context(), sess.Token); err != nil {
		s.log.Warn("logout failed", "err", err.Error())
	}
	http.SetCookie(w, s.auth.ClearCookie())
	s.audit(user, "logout", "session", user.Username, map[string]any{"ok": true})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSession implements GET /api/auth/session.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	sess, user, err := s.auth.Authenticate(r.Context(), r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "no valid session")
		return
	}
	_ = sess
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{
			"username":    user.Username,
			"role":        user.Role,
			"displayName": user.DisplayName,
		},
	})
}
