# Third-Party Notices — StreamGuard

Copyright © 2026 Parsa Fathi. This file records third-party components used by
StreamGuard and their licenses. StreamGuard itself is Apache-2.0.

## Go — `services/ingestor`

| Component | License | Use |
|---|---|---|
| [github.com/jackc/pgx/v5](https://github.com/jackc/pgx) | MIT | PostgreSQL driver (stdlib database/sql adapter) |
| [golang.org/x/crypto](https://go.dev/x/crypto) | BSD-3-Clause | bcrypt password hashing |
| Go standard library | BSD-3-Clause | HTTP server, crypto, JSON, etc. |

## Python — `analytics`

| Component | License | Use |
|---|---|---|
| [numpy](https://numpy.org) | BSD-3-Clause | numeric arrays for ML features |
| Python standard library | PSF-2.0 | HTTP server, JSON, statistics |

## C++ — `native/parser`

No third-party dependencies (hand-written JSON tokenizer, standard library only).

## Web console — `web`

| Component | License | Use |
|---|---|---|
| [Next.js](https://nextjs.org) | MIT | application framework |
| [React](https://react.dev) | MIT | UI |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | language |
| [Tailwind CSS](https://tailwindcss.com) | MIT | styling |
| [Radix UI primitives](https://www.radix-ui.com) (via shadcn/ui patterns) | MIT | accessible components |
| [shadcn/ui](https://ui.shadcn.com) component patterns | MIT | component scaffolding |
| [lucide-react](https://lucide.dev) | ISC | icons |
| [recharts](https://recharts.org) | MIT | charts |
| [TanStack Query](https://tanstack.com/query) | MIT | server state |
| [Zustand](https://zustand.docs.pmnd.rs) | MIT | client state |
| [socket.io / socket.io-client](https://socket.io) | MIT | real-time transport (demo edition) |
| [Prisma](https://www.prisma.io) | Apache-2.0 | data access (demo edition, SQLite) |
| [Zod](https://zod.dev) | MIT | input validation |
| [framer-motion](https://motion.dev) | MIT | subtle UI transitions |
| [sonner](https://sonner.emilkowal.ski) | MIT | toasts |
| [date-fns](https://date-fns.org) | MIT | time formatting |
| [next-themes](https://github.com/pacocoursey/next-themes) | MIT | theme switching |
| z-ai-web-dev-sdk | (sandbox-provided SDK) | AI provider adapter for the hosted demo edition only |

## Fonts and design

The console uses system font stacks (no bundled webfonts). No stock images are
used as product screenshots; all screenshots in `docs/assets/` are captured from
the actual application.

## License texts

- Apache License 2.0: see `LICENSE`
- MIT: <https://opensource.org/licenses/MIT>
- BSD-3-Clause: <https://opensource.org/licenses/BSD-3-Clause>
- ISC: <https://opensource.org/licenses/ISC>
- PSF-2.0: <https://opensource.org/license/python-2-0>

If you believe a notice is missing or incorrect, open an issue — attribution
mistakes will be corrected promptly.
