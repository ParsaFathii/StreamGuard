# Changelog

Copyright © 2026 Parsa Fathi — Apache-2.0

All notable changes to StreamGuard are documented here. Versions follow a
staged generation plan; every tag was buildable and its test suites green at
the time it was cut. Dates are UTC.

## [10.3.0] — 2026-10-19

Release stabilization: documentation, assets and packaging.

- Complete bilingual documentation set: English (README, ARCHITECTURE,
  SECURITY, CONTRIBUTING, THIRD_PARTY_NOTICES, component READMEs) and Persian
  (`docs/fa/` — 14 documents).
- Real screenshots (10) and animated demos (4 GIFs) captured from the running
  application into `docs/assets/` and referenced from both READMEs — live
  attack on the event wall, incident triage lifecycle, AI-assisted
  investigation, English⇆Persian console.
- Release automation validated: tag↔CHANGELOG consistency check, multi-platform
  Go binaries, C++ artifacts, Python sdist, SHA256SUMS, SPDX SBOM.

