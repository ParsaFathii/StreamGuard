<!-- Copyright © 2026 Parsa Fathi — Apache-2.0 -->

# راهنمای توسعه — StreamGuard (نسخهٔ فارسی)

این سند محیط توسعه، ساختار مخزن، قواعد کد، دستورات ساخت/تست هر جزء و خلاصهٔ قواعد مشارکت
را پوشش می‌دهد.

نسخهٔ انگلیسی: [CONTRIBUTING.md](../../CONTRIBUTING.md) و [Makefile](../../Makefile) —
مطالعهٔ مرتبط: [TESTING_FA.md](TESTING_FA.md) و [RELEASE_FA.md](RELEASE_FA.md).

## محیط توسعه

| نیاز | نسخه |
|---|---|
| Go | 1.23+ |
| Python | 3.12+ |
| کامپایلر C++ | C++20 (GCC 12+ / Clang 16+) |
| کنسول وب | Bun 1.1+ |

برای PostgreSQL سرویس Go: `POSTGRES_DSN` را تنظیم کنید؛ بدون آن ذخیره‌ساز درون‌حافظه‌ای
است (برای توسعه/تست کافی است).

## ساختار مخزن

```text
services/ingestor   سرویس مرجع Go (API، خط لوله، قوانین، همبستگی، حادثه‌ها، SSE)
analytics           بستهٔ Python (خط پایه، iForest، ارزیابی، آداپتور LLM، سرویس همراه)
native/parser       پارسر C++20 با C ABI
web                 کنسول Next.js (نسخهٔ دمو + حالت Go-backed)
deploy/docker       Dockerfileها
docs                مستندات EN + FA
.github/workflows   CI و انتشار
```

بسته‌های سرویس Go (`services/ingestor`): `cmd/ingestor` (سیم‌کشی اصلی + خاموشی منظم)،
`cmd/sggen` (تولیدکنندهٔ قطعی)، `internal/api` (لایهٔ HTTP + RBAC)،
`internal/config`، `internal/event`، `internal/store` (PostgreSQL + MemStore)،
`internal/pipeline`، `internal/rules`، `internal/correlate`، `internal/incident`،
`internal/auth`، `internal/audit`، `internal/sse`، `internal/ml`، `internal/llm`،
`internal/metrics`، `internal/logging`، `internal/sim`.

## قواعد کد

- **هدر کپی‌رایت:** هر فایل سورس این سطر را دارد:
  `Copyright © 2026 Parsa Fathi — Apache-2.0`.
- **هویت نسخه:** نسخهٔ محصول از `CHANGELOG.md` و فرادادهٔ بسته‌ها می‌آید؛ همهٔ پاسخ‌ها
  هدر `X-StreamGuard-Version` می‌دهند. نسخهٔ نهایی این مرحله v10.3.2 است.
- **ثبات قرارداد:** قرارداد API/داده میان سرویس Go، بستهٔ Python و کنسول مشترک است؛
  تغییرشکننده یعنی bump نسخه + مدخل CHANGELOG.
- **بدون رمز:** هیچ توکن/کلید/دادهٔ خصوصی‌ای commit نمی‌شود؛ لاگ‌ها هدرهای authorization،
  کوکی‌ها و کلیدهای دریافت را حذف می‌کنند.
- **صداقت مهم‌تر از نشان سبز:** هیچ assertionی برای سبزشدن تست ضعیف نمی‌شود؛ هیچ عدد
  محک/دقتی جعل نمی‌شود؛ هر چیزِ تست‌نشده همین‌طور گفته می‌شود.
- کد شخص ثالث مجوز خودش را نگه می‌دارد و در `THIRD_PARTY_NOTICES.md` ثبت می‌شود.

## دستورات ساخت و تست هر جزء

سرویس Go:

```bash
cd services/ingestor
go vet ./...
go build ./...
go test ./... -race -count=1
# یکپارچگی PostgreSQL (نیازمند POSTGRES_DSN):
go test -tags integration -count=1 ./internal/store/...
# دودکردن مسیر دریافت با تولیدکنندهٔ قطعی:
go run ./cmd/ingestor &
go run ./cmd/sggen --scenario brute_force --url http://127.0.0.1:8080 --key sg-demo-ingest-key-2026
```

پارسر C++:

```bash
cd native/parser
make all && make test && make sanitize
```

بستهٔ Python:

```bash
cd analytics
python3 -m pytest tests/
python3 -m streamguard_analytics evaluate --dataset all
```

کنسول وب:

```bash
cd web
bun install
bun run db:push && bun run seed
bun run dev
bun run lint          # ESLint — باید 0 خطا/0 هشدار باشد
```

## Makefile (اهداف سطح مخزن)

| هدف | کار |
|---|---|
| `make build` | ساخت باینری‌های Go در `services/ingestor/bin/` |
| `make test` | همهٔ مجموعه‌های تست اجزا |
| `make lint` | `go vet` + ESLint کنسول |
| `make sanitize` | اجرای C++ زیر ASan/UBSan |
| `make bench` | محک پارسر C++ |
| `make e2e` | آزمون سرتاسری با فرایند واقعی: ingestor + sggen brute_force + راستی‌آزمایی تشخیص و حادثه |
| `make demo` | اجرای کنسول دموی محلی (نیازمند bun) |
| `make clean` | پاک‌کردن خروجی‌های ساخت |

## اجرای محلی (خلاصهٔ سناریوهای توسعه)

1. سرویس Go را با `go run ./cmd/ingestor` بالا بیاورید (پیش‌فرض :8080).
2. با `sggen` سناریو بفرستید و تشخیص/حادثه را با curl یا کنسول راستی‌آزمایی کنید.
3. برای کنسول دموی خودکفا: `make demo` یا دستورات بخش قبل در `web/`.
4. برای سرویس همراه تحلیل: `python3 -m streamguard_analytics serve --port 8090` و در
   سرویس Go مقدار `ANALYTICS_URL` را تنظیم کنید.

## مشارکت (خلاصه)

1. مخزن را fork کنید و از `main` یک شاخهٔ موضوعی بسازید.
2. تغییر را همراه با تست بنویسید.
3. مجموعهٔ راستی‌آزماییِ همان جزء را اجرا کنید (جدول زیر).
4. PR را با قالب آماده باز کنید و **صادقانه** توضیح دهید چه چیزی را تست کرده‌اید و چه
   چیزی را نه.

| جزء | الزامی قبل از merge |
|---|---|
| `services/ingestor` | `go vet ./...`، `go test ./... -race`، در تغییر API یک بررسی دستی endpoint |
| `native/parser` | `make test`، `make sanitize` |
| `analytics` | `pytest tests/` (قطعی — نتیجهٔ یکسان در اجرای مجدد) |
| `web` | `bun run lint`، بررسی نوع، برای تغییر UI یک گذر دستی مرورگر |

برای تغییرات حساس به کارایی، اندازه‌گیری قبل/بعد همراه روش‌شناسی بیاورید. گزارش مسئله‌ها
با قالب‌های issue؛ مسائل امنیتی فقط از مسیر [SECURITY_FA.md](SECURITY_FA.md).
