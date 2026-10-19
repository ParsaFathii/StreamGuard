// Copyright © 2026 Parsa Fathi — Apache-2.0

// Package api implements the StreamGuard HTTP API layer: routing (Go 1.22
// ServeMux patterns), middleware (version header, request logging, panic
// recovery, per-request timeouts), all /api handlers of the unified contract,
// seeding, and the SSE live stream.
package api

import (
        "context"
        "fmt"
        "net/http"
        "runtime/debug"
        "strings"
        "sync"
        "sync/atomic"
        "time"

        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/auth"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/llm"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/logging"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/metrics"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/pipeline"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
        "github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

// VersionDefault is used by /api/health and X-StreamGuard-Version when the
// Server Config does not override it.
const VersionDefault = "10.4.0"

// Config tunes the Server.
type Config struct {
        Version        string
        RequestTimeout time.Duration // per-request context deadline (default 30s)
        AITimeout      time.Duration // deadline for /api/ai/* (default 90s)
        Now            func() time.Time
}

// Server wires the HTTP API together.
type Server struct {
        cfg  Config
        st   store.Store
        auth *auth.Service
        hub  *sse.Hub
        pipe *pipeline.Pipeline
        llm  *llm.Client
        mtr  *metrics.Counters
        log  *logging.Logger

        started time.Time
        tickSeq atomic.Int64 // deterministic per-tick seeds: 42, 43, ...

        retMu        sync.Mutex
        retLastRun   time.Time
        retDeleted   int64 // cumulative deleted events (process lifetime)
        retAutoCheck time.Time

        llmMu      sync.Mutex
        llmCached  string
        llmChecked time.Time
}

// NewServer creates the API server. llm may be nil (AI investigate then
// reports 503 AI_DISABLED when settings.aiEnabled is on).
func NewServer(cfg Config, st store.Store, as *auth.Service, hub *sse.Hub,
        pipe *pipeline.Pipeline, lc *llm.Client, mtr *metrics.Counters, log *logging.Logger) *Server {
        if cfg.Version == "" {
                cfg.Version = VersionDefault
        }
        if cfg.RequestTimeout <= 0 {
                cfg.RequestTimeout = 30 * time.Second
        }
        if cfg.AITimeout <= 0 {
                cfg.AITimeout = 90 * time.Second
        }
        if cfg.Now == nil {
                cfg.Now = func() time.Time { return time.Now().UTC() }
        }
        if mtr == nil {
                mtr = metrics.NewCounters()
        }
        if log == nil {
                log = logging.Discard()
        }
        return &Server{
                cfg: cfg, st: st, auth: as, hub: hub, pipe: pipe, llm: lc,
                mtr: mtr, log: log, started: cfg.Now(),
        }
}

// Now returns the server clock (injectable for tests).
func (s *Server) Now() time.Time { return s.cfg.Now() }

// UptimeSec returns seconds since server start.
func (s *Server) UptimeSec() int64 { return int64(time.Since(s.started).Seconds()) }

// settings returns the live settings (defaults on error).
func (s *Server) settings() store.Settings {
        sv, err := s.st.GetSettings(context.WithoutCancel(context.Background()))
        if err != nil {
                return store.DefaultSettings()
        }
        return sv
}

// ---------------------------------------------------------------- routing

// routes builds the ServeMux with all contract endpoints.
func (s *Server) routes() *http.ServeMux {
        mux := http.NewServeMux()

        // auth
        mux.HandleFunc("POST /api/auth/login", s.handleLogin)
        mux.HandleFunc("POST /api/auth/logout", s.authed(s.handleLogout))
        mux.HandleFunc("GET /api/auth/session", s.handleSession)

        // ingest (session ADMIN/ANALYST or X-Ingest-Key; handled inside)
        mux.HandleFunc("POST /api/ingest", s.handleIngest)

        // events (all authenticated roles)
        mux.HandleFunc("GET /api/events", s.authed(s.handleEventsList))
        mux.HandleFunc("GET /api/events/{id}", s.authed(s.handleEventDetail))

        // rules
        mux.HandleFunc("GET /api/rules", s.authed(s.handleRulesList))
        mux.HandleFunc("PATCH /api/rules/{id}", s.withRole("ANALYST", "ADMIN")(s.handleRulePatch))
        mux.HandleFunc("GET /api/rules/{id}/audit", s.withRole("ADMIN")(s.handleRuleAuditList))

        // detections
        mux.HandleFunc("GET /api/detections", s.authed(s.handleDetectionsList))

        // incidents
        mux.HandleFunc("GET /api/incidents", s.authed(s.handleIncidentsList))
        mux.HandleFunc("GET /api/incidents/{id}", s.authed(s.handleIncidentDetail))
        mux.HandleFunc("PATCH /api/incidents/{id}", s.withRole("ANALYST", "ADMIN")(s.handleIncidentPatch))
        mux.HandleFunc("POST /api/incidents/{id}/notes", s.withRole("ANALYST", "ADMIN")(s.handleIncidentNote))
        mux.HandleFunc("GET /api/incidents/{id}/events", s.authed(s.handleIncidentEvents))

        // analytics + ml
        mux.HandleFunc("GET /api/analytics/overview", s.authed(s.handleOverview))
        mux.HandleFunc("GET /api/analytics/timeseries", s.authed(s.handleTimeseries))
        mux.HandleFunc("GET /api/analytics/ml", s.authed(s.handleMlView))
        mux.HandleFunc("POST /api/analytics/ml/evaluate", s.withRole("ANALYST", "ADMIN")(s.handleMlEvaluate))

        // ai
        mux.HandleFunc("POST /api/ai/investigate", s.withRole("ANALYST", "ADMIN")(s.handleAIInvestigate))

        // simulator
        mux.HandleFunc("GET /api/simulator/scenarios", s.authed(s.handleScenarios))
        mux.HandleFunc("POST /api/simulator/scenario", s.withRole("ANALYST", "ADMIN")(s.handleScenarioRun))
        mux.HandleFunc("POST /api/simulator/tick", s.withRole("ANALYST", "ADMIN")(s.handleTick))
        mux.HandleFunc("POST /api/simulator/reset", s.withRole("ADMIN")(s.handleSimulatorReset))

        // sources / system
        mux.HandleFunc("GET /api/sources", s.authed(s.handleSources))
        mux.HandleFunc("GET /api/health", s.handleHealth)
        mux.HandleFunc("GET /api/metrics", s.handleMetrics)
        mux.HandleFunc("GET /api/audit", s.withRole("ADMIN")(s.handleAuditList))
        mux.HandleFunc("GET /api/settings", s.authed(s.handleSettingsGet))
        mux.HandleFunc("PATCH /api/settings", s.withRole("ADMIN")(s.handleSettingsPatch))
        mux.HandleFunc("POST /api/system/retention-run", s.withRole("ADMIN")(s.handleRetentionRun))

        // live stream (any authenticated role)
        mux.HandleFunc("GET /api/stream", s.authed(s.handleStream))

        // JSON 404 for everything unmatched (wrong path or unsupported method).
        mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
                writeError(w, http.StatusNotFound, "NOT_FOUND", "no such route: "+r.Method+" "+r.URL.Path)
        })
        return mux
}

// Handler builds the full middleware chain around the mux:
// recover -> version header -> request log -> per-request timeout -> mux.
func (s *Server) Handler() http.Handler {
        mux := s.routes()
        var h http.Handler = mux
        h = s.timeoutMiddleware(h)
        h = s.loggingMiddleware(h)
        inner := h // version header wrapper (captured before reassignment)
        h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("X-StreamGuard-Version", s.cfg.Version)
                inner.ServeHTTP(w, r)
        })
        h = s.recoverMiddleware(h)
        return h
}

// ---------------------------------------------------------------- middleware

// statusWriter captures the response status and byte count for logging.
type statusWriter struct {
        http.ResponseWriter
        status int
        bytes  int
}

func (sw *statusWriter) WriteHeader(code int) {
        if sw.status == 0 {
                sw.status = code
        }
        sw.ResponseWriter.WriteHeader(code)
}

func (sw *statusWriter) Write(b []byte) (int, error) {
        if sw.status == 0 {
                sw.status = http.StatusOK
        }
        n, err := sw.ResponseWriter.Write(b)
        sw.bytes += n
        return n, err
}

// Flush implements http.Flusher (needed by SSE).
func (sw *statusWriter) Flush() {
        if f, ok := sw.ResponseWriter.(http.Flusher); ok {
                f.Flush()
        }
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                start := time.Now()
                sw, ok := w.(*statusWriter)
                if !ok {
                        sw = &statusWriter{ResponseWriter: w}
                }
                defer func() {
                        status := sw.status
                        if status == 0 {
                                status = http.StatusOK
                        }
                        // Fixed small field set; no headers, no query, no body (redaction
                        // by construction — logging pkg would redact anyway).
                        s.log.Info("http request",
                                "method", r.Method,
                                "path", r.URL.Path,
                                "status", status,
                                "dur_ms", time.Since(start).Milliseconds(),
                                "bytes", sw.bytes,
                                "remote", remoteAddr(r),
                        )
                }()
                next.ServeHTTP(sw, r)
        })
}

func remoteAddr(r *http.Request) string {
        if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
                return r.RemoteAddr[:i]
        }
        return r.RemoteAddr
}

// recWriter detects whether anything was written (panic recovery).
type recWriter struct {
        http.ResponseWriter
        wrote bool
}

func (rw *recWriter) WriteHeader(code int) {
        rw.wrote = true
        rw.ResponseWriter.WriteHeader(code)
}

func (rw *recWriter) Write(b []byte) (int, error) {
        rw.wrote = true
        return rw.ResponseWriter.Write(b)
}

func (rw *recWriter) Flush() {
        if f, ok := rw.ResponseWriter.(http.Flusher); ok {
                f.Flush()
        }
}

func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                defer func() {
                        if rec := recover(); rec != nil {
                                s.log.Error("handler panic", "panic", fmt.Sprint(rec), "path", r.URL.Path, "stack", string(debug.Stack()))
                                if rw, ok := w.(*recWriter); !ok || !rw.wrote {
                                        writeError(w, http.StatusInternalServerError, "INTERNAL", "internal server error")
                                }
                        }
                }()
                rw, ok := w.(*recWriter)
                if !ok {
                        rw = &recWriter{ResponseWriter: w}
                }
                next.ServeHTTP(rw, r)
        })
}

func (s *Server) timeoutMiddleware(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                switch {
                case r.URL.Path == "/api/stream":
                        // Long-lived SSE: no request deadline (client disconnect governs).
                        next.ServeHTTP(w, r)
                        return
                case strings.HasPrefix(r.URL.Path, "/api/ai/"):
                        ctx, cancel := context.WithTimeout(r.Context(), s.cfg.AITimeout)
                        defer cancel()
                        next.ServeHTTP(w, r.WithContext(ctx))
                        return
                default:
                        ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
                        defer cancel()
                        next.ServeHTTP(w, r.WithContext(ctx))
                }
        })
}

// ---------------------------------------------------------------- auth glue

// authedHandler receives an authenticated session and user.
type authedHandler func(w http.ResponseWriter, r *http.Request, sess *store.Session, user *store.User)

// authed wraps a handler requiring any authenticated session.
func (s *Server) authed(h authedHandler) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
                sess, user, err := s.auth.Authenticate(r.Context(), r)
                if err != nil {
                        writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "authentication required (login or Bearer token)")
                        return
                }
                h(w, r, sess, user)
        }
}

// withRole wraps a handler requiring one of the given roles.
func (s *Server) withRole(roles ...string) func(authedHandler) http.HandlerFunc {
        return func(h authedHandler) http.HandlerFunc {
                return func(w http.ResponseWriter, r *http.Request) {
                        sess, user, err := s.auth.Authenticate(r.Context(), r)
                        if err != nil {
                                writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "authentication required (login or Bearer token)")
                                return
                        }
                        if !roleIn(user.Role, roles) {
                                writeError(w, http.StatusForbidden, "FORBIDDEN",
                                        fmt.Sprintf("role %s is not allowed for %s %s", user.Role, r.Method, r.URL.Path))
                                return
                        }
                        h(w, r, sess, user)
                }
        }
}

func roleIn(role string, allowed []string) bool {
        for _, a := range allowed {
                if role == a {
                        return true
                }
        }
        return false
}

// ---------------------------------------------------------------- stats loop

// Start launches the periodic stats publisher (SSE channel "stats", every
// 5s). It stops when ctx is done. One goroutine, no leaks.
func (s *Server) Start(ctx context.Context) {
        go func() {
                ticker := time.NewTicker(5 * time.Second)
                defer ticker.Stop()
                for {
                        select {
                        case <-ctx.Done():
                                return
                        case <-ticker.C:
                                s.publishStats()
                        }
                }
        }()
}

func (s *Server) publishStats() {
        ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 3*time.Second)
        defer cancel()
        now := s.Now()
        events24h, _ := s.st.CountEventsSince(ctx, now.Add(-24*time.Hour))
        byRule, _ := s.st.DetectionCountsByRuleSince(ctx, now.Add(-24*time.Hour))
        var detections24h int64
        for _, n := range byRule {
                detections24h += n
        }
        open, _, _ := s.st.IncidentCounts(ctx, now)
        depth := 0
        if s.pipe != nil {
                depth = s.pipe.Depth()
        }
        s.hub.Publish(sse.ChannelStats, sse.StatsPayload{
                Events24h:     events24h,
                Detections24h: detections24h,
                IncidentsOpen: open,
                QueueDepth:    depth,
                UpdatedAt:     sse.FormatTime(now),
        })
}

// llmStatus probes (and briefly caches) the AI provider state:
// "ok" | "error" | "disabled".
func (s *Server) llmStatus() string {
        sv := s.settings()
        if !sv.AIEnabled {
                return "disabled"
        }
        if s.llm == nil {
                return "error"
        }
        s.llmMu.Lock()
        defer s.llmMu.Unlock()
        if time.Since(s.llmChecked) < 30*time.Second {
                return s.llmCached
        }
        st := s.llm.Status(context.Background())
        if st == "" {
                st = "error"
        }
        s.llmCached = st
        s.llmChecked = time.Now()
        return st
}
