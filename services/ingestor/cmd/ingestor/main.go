// Copyright © 2026 Parsa Fathi — Apache-2.0

// Command ingestor is the StreamGuard Go reference service: ingest, rule
// engine, correlation, incidents, analytics, AI assistant, simulator and the
// HTTP/SSE API. Store selection: POSTGRES_DSN -> PostgreSQL, else in-memory.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/api"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/auth"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/config"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/correlate"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/llm"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/logging"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/metrics"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/pipeline"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/rules"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/sse"
	"github.com/ParsaFathii/StreamGuard/services/ingestor/internal/store"
)

const shutdownGrace = 10 * time.Second

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, `{"level":"error","msg":"fatal: %v"}`+"\n", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	level := strings.TrimSpace(os.Getenv("LOG_LEVEL"))
	if level == "" {
		level = "info"
	}
	logger := logging.New(os.Stdout, level)

	// --- store selection.
	var st store.Store
	if cfg.PostgresDSN != "" {
		st, err = store.NewPostgresStore(ctx, cfg.PostgresDSN)
		if err != nil {
			return fmt.Errorf("postgres store: %w", err)
		}
		logger.Info("store=postgres connected (schema applied under advisory lock)")
	} else {
		st = store.NewMemStore()
		logger.Warn("STORE=memory (no POSTGRES_DSN) — data is not durable")
	}
	defer st.Close()

	// --- live settings accessor (settings changes take effect without restart).
	settingsFn := func() store.Settings {
		s, err := st.GetSettings(context.WithoutCancel(ctx))
		if err != nil {
			return store.DefaultSettings()
		}
		return s
	}

	authService := auth.NewService(st, []byte(cfg.SessionSecret), func() int {
		return settingsFn().RateLimitPerMin
	})

	// --- seed (idempotent).
	initial := store.Settings{
		AIEnabled:                true,
		AIProvider:               "ollama",
		CorrelationWindowSeconds: cfg.CorrelationWindowSeconds,
		RetentionHours:           cfg.RetentionHours,
		MaxBatchSize:             cfg.MaxBatch,
		RateLimitPerMin:          cfg.RateLimitPerMin,
		LanguageDefault:          "en",
	}
	if err := api.Seed(ctx, st, authService, cfg.IngestKey, initial); err != nil {
		return fmt.Errorf("seed: %w", err)
	}

	// --- processing engine.
	hub := sse.NewHub()
	mtr := metrics.NewCounters()
	engine := rules.NewEngine(st, nil)
	corr := correlate.NewEngine(st, nil, func() time.Duration {
		return time.Duration(settingsFn().CorrelationWindowSeconds) * time.Second
	})
	pipe := pipeline.New(st, engine, corr, hub, mtr, logger, pipeline.Config{})
	pipe.Start(ctx)

	// --- LLM provider (Ollama-compatible; AI is optional and read-only).
	llmClient := llm.NewClient(cfg.LLMBaseURL, cfg.LLMModel, 45*time.Second)

	srv := api.NewServer(api.Config{
		Version: config.Version,
	}, st, authService, hub, pipe, llmClient, mtr, logger)

	httpSrv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           srv.Handler(),
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      0, // 0 on purpose: /api/stream is long-lived SSE
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	logger.Info("streamguard ingestor starting",
		"version", config.Version,
		"config", cfg.Redacted(),
	)

	rootCtx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	srv.Start(rootCtx) // periodic stats publisher (stops with rootCtx)

	errCh := make(chan error, 1)
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	logger.Info("listening", "addr", httpSrv.Addr)

	select {
	case <-rootCtx.Done():
		logger.Info("shutdown signal received; draining (max " + shutdownGrace.String() + ")")
	case err := <-errCh:
		return err
	}

	// Graceful shutdown: stop accepting, drain in-flight requests, drain the
	// pipeline, then close the store.
	stopSignals()
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownGrace)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown incomplete", "err", err.Error())
	}
	if err := pipe.Stop(shutdownCtx); err != nil {
		logger.Warn("pipeline drain incomplete", "err", err.Error())
	}
	if err := st.Close(); err != nil {
		logger.Warn("store close failed", "err", err.Error())
	}
	logger.Info("shutdown complete", "processed_total", mtr.Processed())
	return nil
}
