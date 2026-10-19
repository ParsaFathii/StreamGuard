<!-- Copyright © 2026 Parsa Fathi — Apache-2.0 -->

# راهنمای نصب و راه‌اندازی — StreamGuard

این سند پیش‌نیازها، نصب تک‌تک اجزا و کل مجموعه با Docker Compose، جدول متغیرهای محیطی و
عیب‌یابی نصب را پوشش می‌دهد.

مطالعهٔ مرتبط: [README_FA.md](README_FA.md) (نمای کلی) — نسخهٔ انگلیسی:
[README.md](../../README.md) و README اجزای
[services/ingestor](../../services/ingestor/README.md)،
[analytics](../../analytics/README.md)،
[native/parser](../../native/parser/README.md) و [web](../../web/README.md).

## پیش‌نیازها

| جزء | پیش‌نیاز |
|---|---|
| کل مجموعه با Docker | Docker + Docker Compose (ساده‌ترین راه) |
| سرویس Go | Go 1.23+؛ PostgreSQL 16+ (اختیاری — بدون آن، ذخیره‌ساز درون‌حافظه‌ای) |
| بستهٔ تحلیل Python | Python ≥ 3.12 و `numpy>=1.26` (تنها وابستگی اجرایی) |
| پارسر C++ | کامپایلر C++20 (GCC 12+ / Clang 16+) — فقط اگر بخواهید آن را بسازید |
| کنسول وب | Bun 1.1+ |
| دستیار هوش مصنوعی (اختیاری) | یک endpoint سازگار [Ollama](https://ollama.com) در `LLM_BASE_URL` |

## روش A — کل مجموعه با Docker Compose

```bash
docker compose up --build
```

چهار سرویس راه‌اندازی می‌شود:

| سرویس | پورت | نقش |
|---|---|---|
| `postgres` | 5432 | ذخیره‌ساز پایا (تصویر `postgres:16-alpine`) |
| `ingestor` | 8080 | سرویس Go (دریافت، خط لوله، قوانین، حادثه‌ها، SSE) |
| `analytics` | 8090 | سرویس همراه Python (خط پایه، Isolation Forest، ارزیابی) |
| `web` | 3000 | کنسول در حالت Go-backed (سسشن از طریق `NEXT_PUBLIC_API_BASE`) |

بعد از بالا آمدن: کنسول `http://localhost:3000`، سلامت سرویس Go
`http://localhost:8080/api/health` و سلامت سرویس تحلیل `http://localhost:8090/health`.

## روش B — نصب سرویس Go از سورس

```bash
cd services/ingestor
go build ./...
go run ./cmd/ingestor            # :8080 — ذخیره‌ساز درون‌حافظه‌ای (بدون POSTGRES_DSN)
```

با PostgreSQL:

```bash
POSTGRES_DSN=postgres://user:pass@host:5432/db go run ./cmd/ingestor
```

- مهاجرت‌های شِما (فایل `internal/store/schema.sql`) در زمان راه‌اندازی خودکار و زیر
  advisory lock اعمال می‌شوند؛ اگر نمونهٔ دیگری در حال مهاجرت باشد، منتظر می‌ماند و خودش
  حل می‌شود.
- بدون `POSTGRES_DSN` سرویس درخواست `STORE=memory ... data is not durable` را در لاگ
  می‌نویسد — این هشدار عمدی است: ذخیره‌ساز درون‌حافظه‌ای پایا نیست و برای تست/اجرای
  موقت در نظر گرفته شده است.
- ابزار تولید رخداد قطعی برای دودکردن مسیر دریافت:

```bash
go run ./cmd/sggen --scenario brute_force --url http://127.0.0.1:8080 --key sg-demo-ingest-key-2026
go run ./cmd/sggen --scenario traffic_burst --count 140 --seed 7 --url http://127.0.0.1:8080 --key sg-demo-ingest-key-2026
```

در اولین راه‌اندازی، داده‌های دمو seed می‌شوند (insert-if-absent): کاربران
`admin/admin123`، `analyst/analyst123`، `viewer/viewer123`، کلید دریافت `demo-key-01`
با مقدار `INGEST_KEY`، ۷ قانون پیش‌فرض و تنظیمات پایه. **در هر استقرار واقعی همهٔ این
مقادیر را عوض کنید.**

## روش C — کنسول دموی مستقل

```bash
cd web
bun install
bun run db:push        # ساخت شِمای SQLite (فایل db/console.db)
bun run seed           # کاربران دمو، قوانین و ~۴-۵ ساعت تاریخچهٔ تولیدی با موتور
bun run dev            # http://localhost:3000
# رلهٔ جریان زنده (socket.io) — بدون آن، به‌روزرسانی زنده کار نمی‌کند:
cd mini-services/stream && bun run dev
```

پایگاه داده خارجی لازم نیست؛ SQLite از طریق Prisma تعبیه شده است. حالت Go-backed
(اشارهٔ همان UI به سرویس Go با انتقال SSE):

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8080 NEXT_PUBLIC_LIVE_TRANSPORT=sse bun run dev
```

## نصب بستهٔ تحلیل Python

```bash
python3 -m pip install -e ./analytics     # نصب editable برای توسعه
python3 -m pip install ./analytics        # نصب معمولی
# یا اجرا بدون نصب:
PYTHONPATH=analytics/src python3 -m streamguard_analytics --help
```

اجرا به‌صورت سرویس همراه (پیش‌فرض پورت 8090):

```bash
python3 -m streamguard_analytics serve --host 127.0.0.1 --port 8090
```

سرویس همراه stateless است؛ هیچ حالتی بین درخواست‌ها نگه نمی‌دارد و در هر لحظه می‌توان
آن را ری‌استارت کرد.

## نصب پارسر C++ (اختیاری)

```bash
cd native/parser
make all          # کتابخانهٔ استاتیک + کتابخانهٔ اشتراکی C ABI
make test         # ۵۳۰ بررسی
make sanitize     # همان مجموعه زیر ASan + UBSan + LSan
```

پارسر پیش‌فرض سرویس Go خالص‌Go است (`internal/event`)؛ لینک‌کردن پارسر C++ پشت build tag
یک بهینه‌سازی اختیاری و به‌دلیل‌شده با محک است. برای جزئیات مالکیت حافظه و C ABI به
[native/parser/README.md](../../native/parser/README.md) مراجعه کنید.

## متغیرهای محیطی — سرویس Go

| متغیر | پیش‌فرض | معنا |
|---|---|---|
| `PORT` | `8080` | پورت HTTP |
| `POSTGRES_DSN` | *(خالی)* | DSN PostgreSQL؛ خالی → ذخیره‌ساز درون‌حافظه‌ای (غیرپایا، لاگ می‌شود) |
| `SESSION_SECRET` | مقدار توسعه | رمز HMAC کوکی نشست — **در عملیات حتماً تنظیم شود** |
| `INGEST_KEY` | `sg-demo-ingest-key-2026` | مقدار کلید دریافت برای هدر `X-Ingest-Key` |
| `RATE_LIMIT_PER_MIN` | `60` | سقف درخواست دریافت به‌ازای کلید/کاربر در دقیقه |
| `MAX_BATCH` | `100` | بیشینهٔ رخداد در هر batch |
| `RETENTION_HOURS` | `72` | TTL رخدادها (شواهد حادثه‌های باز هرگز حذف نمی‌شوند) |
| `CORRELATION_WINDOW_SECONDS` | `600` | پنجرهٔ همبستگی |
| `LLM_BASE_URL` | `http://127.0.0.1:11434` | endpoint سازگار Ollama برای دستیار تحقیق |
| `LLM_MODEL` | `llama3.2` | نام مدل |
| `ANALYTICS_URL` | *(خالی)* | URL سرویس همراه Python (اختیاری) |

## متغیرهای محیطی — کنسول وب و سرویس همراه

| متغیر | پیش‌فرض | معنا |
|---|---|---|
| `DATABASE_URL` | `file:./db/console.db` | مسیر SQLite (نسخهٔ دمو) |
| `NEXT_PUBLIC_API_BASE` | *(خالی)* | آدرس سرویس Go در حالت Go-backed |
| `NEXT_PUBLIC_LIVE_TRANSPORT` | `socketio` | `socketio` (دمو) یا `sse` (Go) |
| `ANALYTICS_PORT` | `8090` | پورت سرویس همراه تحلیل |

## عیب‌یابی نصب

| نشانه | راه‌حل |
|---|---|
| هشدار `STORE=memory` در راه‌اندازی | بدون `POSTGRES_DSN` طبیعی است؛ برای ذخیرهٔ پایا DSN را تنظیم کنید |
| `503 AI_DISABLED` روی `/api/ai/investigate` | هوش مصنوعی تا فعال‌شدن در تنظیمات و پیکربندی سرویس‌دهنده خاموش است (طراحی عمدی) |
| خطای 503 سرویس‌دهنده از AI | `LLM_BASE_URL`/مدل را بررسی کنید (`ollama list`)؛ fallback ابری وجود ندارد |
| `429` روی دریافت | محدودیت نرخ (پیش‌فرض ۶۰/دقیقه) — صبر کنید یا `RATE_LIMIT_PER_MIN` را بالا ببرید |
| کنسول به‌روزرسانی زنده نشان نمی‌دهد (دمو) | سرویس رله باید اجرا شود: `cd mini-services/stream && bun run dev` |
| شماره‌گذاری `INC` بعد از بازنشانی | حادثه‌ها بعد از reset دمو از INC-000001 دوباره شماره می‌خورند |
| انتظار قفل مهاجرت Postgres | نمونهٔ دیگری در حال مهاجرت است؛ خودبه‌خود حل می‌شود |
| نصب `analytics` شکست می‌خورد | Python ≥ 3.12 و `numpy>=1.26` لازم است؛ وابستگی اجرایی دیگری وجود ندارد |

مراحل بعدی: [USER_GUIDE_FA.md](USER_GUIDE_FA.md) برای کار با کنسول و
[DEVELOPMENT_FA.md](DEVELOPMENT_FA.md) برای محیط توسعه.
