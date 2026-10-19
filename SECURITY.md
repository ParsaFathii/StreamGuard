# Security Policy — StreamGuard

Copyright © 2026 Parsa Fathi. Licensed under Apache-2.0.

## Supported versions

StreamGuard is under active development. Security fixes target the latest
published release (see [Releases](https://github.com/ParsaFathii/StreamGuard/releases)).
Older minor versions do not receive backports unless a critical issue requires it.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately via [GitHub Security Advisories](https://github.com/ParsaFathii/StreamGuard/security/advisories/new)
("Report a vulnerability"). If that channel is unavailable to you, contact the
maintainer through the repository owner profile.

Please include:

- a description of the issue and its impact,
- affected component (`services/ingestor`, `native/parser`, `analytics`, `web`),
- reproduction steps or proof of concept,
- any mitigations you identified.

You should receive an acknowledgment within 7 days. Please allow up to 90 days
for a fix or coordinated disclosure.

## Scope notes

StreamGuard intentionally ships a **demo/evaluation console** with demo-grade
credentials (`admin/admin123` and similar) and a seeded ingest key. These are
clearly labeled and documented. Reports about those demo credentials being weak
are known-by-design; the production deployment path (Go service + PostgreSQL)
is where authentication hardening matters. When reporting, distinguish between
the demo edition and the reference deployment.

Out of scope:

- attacks requiring physical access or a compromised host,
- volumetric DoS of demo instances,
- issues in dependencies that are already fixed upstream (report them upstream;
  Dependabot keeps this repository current),
- social engineering.

## Security-relevant design commitments

- Authentication and RBAC (ADMIN / ANALYST / VIEWER) are enforced server-side on
  every endpoint — the UI never acts as the only gate.
- Ingestion is authenticated (session or ingest key) and rate-limited.
- All SQL access is parameterized; no string-built queries.
- Event payloads and external log content are treated as untrusted input,
  including for the AI investigation assistant (prompt-injection resistant
  evidence wrapping, advisory-only AI, no AI-initiated state changes).
- Secrets are never committed; logs redact authorization headers, cookies and
  ingest keys.
- Validation failures are recorded, not silently discarded.

## Threat model summary

| Area | Threat | Mitigation |
|---|---|---|
| Ingestion | Malformed/oversized payloads | strict schema validation, 256 KB body / 4 KB event / 100-event batch caps, recorded rejections |
| Ingestion | Flooding | per-key/user sliding-window rate limits, bounded queues, backpressure |
| Auth | Credential/session attacks | bcrypt password hashing, HMAC-signed opaque sessions, expiry, HttpOnly cookies |
| AuthZ | Privilege escalation | server-side RBAC on every route, audited sensitive operations |
| Injection | SQL injection | parameterized queries only |
| Injection | Prompt injection via event text | untrusted-data wrapping, bounded evidence, output validation, advisory-only AI |
| Data | Retention/privacy leaks | configurable retention, incident-evidence protection, no secrets in responses |
| Supply chain | Vulnerable dependencies | pinned versions, Dependabot, CI checks |
| Audit | Tampering/repudiation | append-only audit log of sensitive actions with actor and timestamp |

See `ARCHITECTURE.md` and `docs/fa/SECURITY_FA.md` for details.

## Attribution

Coordinated disclosures are credited in `CHANGELOG.md` unless you prefer to
remain anonymous.
