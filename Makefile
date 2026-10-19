# Copyright © 2026 Parsa Fathi — Apache-2.0
# StreamGuard — top-level developer targets
SHELL := /bin/bash
GO    ?= go
PY    ?= python3

.PHONY: help build test test-go test-cpp test-python test-web lint lint-web sanitize bench e2e demo clean dist

help:
	@echo "StreamGuard targets:"
	@echo "  make build      — build Go binaries (services/ingestor/bin/)"
	@echo "  make test       — run all component test suites"
	@echo "  make lint       — lint (web console eslint; go vet)"
	@echo "  make sanitize   — C++ ASan/UBSan run"
	@echo "  make bench      — C++ parser benchmark"
	@echo "  make e2e        — real-process E2E: ingestor + sggen brute_force + verify incident"
	@echo "  make demo       — run the web console demo edition locally (needs bun)"
	@echo "  make clean      — remove build artifacts"

build:
	cd services/ingestor && $(GO) build -o bin/ingestor ./cmd/ingestor && $(GO) build -o bin/sggen ./cmd/sggen

test-go:
	cd services/ingestor && $(GO) vet ./... && $(GO) test ./... -race -count=1

test-cpp:
	cd native/parser && make test

test-python:
	cd analytics && $(PY) -m pytest tests/ -q

test-web:
	cd web && bun run lint && bunx tsc --noEmit

test: test-go test-cpp test-python test-web

lint:
	cd services/ingestor && $(GO) vet ./...
	cd web && bun run lint

sanitize:
	cd native/parser && make sanitize

bench:
	cd native/parser && make bench

e2e: build
	@set -e; \
	  PORT=8091 INGEST_KEY=sg-demo-ingest-key-2026 services/ingestor/bin/ingestor & \
	  PID=$$!; trap 'kill $$PID 2>/dev/null || true' EXIT; \
	  ok=0; for i in $$(seq 1 20); do \
	    if curl -sf http://127.0.0.1:8091/api/health > /dev/null 2>&1; then ok=1; break; fi; sleep 0.5; \
	  done; \
	  if [ "$$ok" != "1" ]; then echo "E2E FAIL: service did not become healthy"; exit 2; fi; \
	  curl -sf http://127.0.0.1:8091/api/health; echo; \
	  services/ingestor/bin/sggen --scenario brute_force --url http://127.0.0.1:8091 --key sg-demo-ingest-key-2026; \
	  sleep 2; \
	  curl -sf -c /tmp/sg-cj -X POST http://127.0.0.1:8091/api/auth/login -H 'content-type: application/json' \
	    -d '{"username":"admin","password":"admin123"}' > /dev/null; \
	  DET=$$(curl -sf -b /tmp/sg-cj "http://127.0.0.1:8091/api/detections?ruleId=SG-RULE-001" | $(PY) -c 'import json,sys;print(len(json.load(sys.stdin)["data"]))'); \
	  INC=$$(curl -sf -b /tmp/sg-cj "http://127.0.0.1:8091/api/incidents" | $(PY) -c 'import json,sys;print(len(json.load(sys.stdin)["data"]))'); \
	  echo "E2E: detections=$$DET incidents=$$INC"; \
	  kill $$PID; test "$$DET" -ge 1 && test "$$INC" -ge 1 && echo "E2E PASS"

demo:
	cd web && bun install && bun run db:push && bun run seed && bun run dev

clean:
	cd services/ingestor && rm -rf bin
	cd native/parser && make clean
	rm -rf analytics/build analytics/dist
