<!-- Copyright © 2026 Parsa Fathi — Apache-2.0 -->

# StreamGuard — مستندات فارسی (نمای کلی پروژه)

**پردازش رخداد لحظه‌ای، تحلیل امنیتی و بررسی حادثه‌ها با کمک هوش مصنوعی**

StreamGuard رخدادها را دریافت می‌کند، اعتبارسنجی و نرمال‌سازی می‌کند، قوانین تشخیصِ قطعی را
اعمال می‌کند، تشخیص‌های مرتبط را با هم همبسته می‌سازد و گردش کار بررسی حادثه را با تاریخچهٔ
رخدادِ قابل جست‌وجو، جریان زنده، تحلیل ناهنجاری آماری/یادگیری ماشین و یک **دستیار هوش مصنوعی
محلیِ اختیاری و مبتنی بر شواهد** پشتیبانی می‌کند.

این یک سامانهٔ واقعی و کارکردی است: هر مرحلهٔ خط لوله قابل تست است، هر عددِ نمایش‌داده‌شده از
دادهٔ واقعی می‌آید، دادهٔ ساختگی همیشه برچسب‌دار است و کل مجموعه بدون اجزای هوش مصنوعی هم
کاملاً کار می‌کند.

نسخهٔ انگلیسی این سند: [README.md](../../README.md)

---

## واژه‌نامه (English ↔ فارسی)

اصطلاحات فنی این مجموعهٔ مستندات بر اساس جدول زیر به کار می‌روند. در رابط کاربری فارسیِ
کنسول نیز معادل‌های همین جدول به کار رفته‌اند.

| English | فارسی | توضیح |
|---|---|---|
| event | رخداد | واحد دادهٔ ورودی (با `event_id`) |
| incident | حادثه | خروجی همبستگیِ تشخیص‌ها (شناسهٔ `INC-xxxxxx`)؛ در رابط کاربری: «رخداد امنیتی» |
| detection | تشخیص | تطبیق یک قانون روی رخدادها |
| rule | قانون تشخیص | قانون قطعی با انتخابگر/شرط/آستانه |
| correlation | همبستگی | گروه‌بندی تشخیص‌های مرتبط در یک حادثهٔ باز |
| pipeline | خط لوله | صف محدود + استخر پردازش پس از اعتبارسنجی |
| queue | صف | صف کران‌دار (capacity 1024) |
| live stream | جریان زنده | به‌روزرسانی لحظه‌ای رخداد/تشخیص/حادثه (SSE یا socket.io) |
| severity | شدت | info / low / medium / high / critical |
| threshold | آستانه | مقدارِ فعال‌شدنِ شرط قانون |
| window | پنجره | بازهٔ زمانی ارزیابی شرط |
| cooldown | فروکش | حداقل فاصلهٔ زمانی بین دو شعلهٔ یک قانون |
| suppression | فرونشانی | وضعیت `SUPPRESSED` برای تشخیصِ تکراریِ داخل فروکش |
| triage | طبقه‌بندی | انتقال حادثه از `NEW` به `TRIAGED` |
| audit | ممیزی | تاریخچهٔ ضمیمه‌شدنیِ عملیات حساس |
| retention | نگهداشت (داده) | سیاست TTL داده‌ها (پیش‌فرض ۷۲ ساعت) |
| baseline | خط پایه | میانگین متحرک EWMA برای مقایسه |
| anomaly | ناهنجاری | انحراف معنادار از خط پایه |
| feature vector | بردار ویژگی | ۵ ویژگی دقیقه‌ای هر منبع |
| ingest / ingestion | دریافت | ارسال رخداد به `POST /api/ingest` |
| ingest key | کلید دریافت | هدر `X-Ingest-Key` برای دریافت بی‌نشست |
| session | نشست | کوکی امضاشدهٔ `sg_session` |
| source | منبع | فرستندهٔ رخداد (`source_id`) |
| actor | عامل | کاربر/سرویسِ انجام‌دهندهٔ عمل در رخداد |
| origin | خاستگاه | `synthetic` یا `external` |
| category | دسته | دستهٔ رخداد (auth، network، application و…) |
| attributes | ویژگی‌ها | شیء JSON اختیاری روی رخداد |
| selector | انتخابگر | فیلترِ رخدادهای ورودیِ یک قانون |
| evidence bundle | بستهٔ شواهد | ورودیِ محدودشدهٔ دستیار هوش مصنوعی |
| prompt injection | تزریق دستور | تلاش برای هدایت LLM از طریق متن رخداد |
| idempotency | توان‌نمایی | تکرارِ `event_id` دوباره ذخیره نمی‌شود |
| backpressure | فشار معکوس | رد 429 در پرشدن صف |
| graceful shutdown | خاموشی منظم | تخلیهٔ صف قبل از توقف |
| rate limit | محدودیت نرخ | سقف درخواست در دقیقه |
| sidecar | سرویس همراه | سرویس Python در کنار سرویس Go |
| benchmark | محک | سنجهٔ کارایی با روش شفاف |
| end-to-end (E2E) | آزمون سرتاسری | تست با فرایند واقعی از ابتدا تا انتها |
| release | انتشار | انتشار نسخهٔ برچسب‌خورده |

اصطلاحاتی که معادل رایج فارسی ندارند (SSE، EWMA، Isolation Forest، SBOM و…) عیناً به
صورت انگلیسی باقی می‌مانند.

---

## StreamGuard چه کار می‌کند؟

StreamGuard سه پس‌زمینهٔ قابل تست با یک قرارداد مشترک دارد: سرویس مرجع Go، بستهٔ تحلیل
Python و کنسول وب (React/TypeScript). یک کتابخانهٔ پارسر C++20 هم مرحلهٔ اولِ مسیر دریافت
را در صورت تمایل شتاب می‌دهد (اختیاری، پشت build tag).

```text
Event Sources ──▶ Ingestion API ──▶ Validation ──▶ Processing Pipeline
                                                     │
                          Detection Rules ◀──────────┤──────────▶ Stream Analytics
                                                     │
                                        Correlation Engine
                                                     │
                                        Incident Manager ──▶ PostgreSQL
                                                     │
                                  Web Console ◀── Incident API ──▶ Python ML
                                                     │
                                        Optional Local LLM
```

## کاربردها

- **پایش امنیتی** — تلاش‌های مکرر ورود ناموفق، الگوهای credential stuffing، خطاهای
  مجوزدهی و تغییرات پیکربندی غیرمنتظره.
- **پایش عملیاتی** — جهش نرخ درخواست، افزایش نسبت خطا و ناهنجاری سرویس‌ها با خط پایهٔ
  آماری و Isolation Forest.
- **پاسخ به حادثه** — چرخهٔ عمر اعتبارسنجی‌شدهٔ حادثه، همبستگی تشخیص‌های مرتبط، خط
  زمانی شواهد، یادداشت بررسی و رد ممیزی.
- **ارزیابی و آموزش** — سناریوهای قطعی و seed‌دار (حملهٔ Brute Force، جهش ترافیک،
  توفان خطا و…) با خروجی مورد انتظارِ از پیش معلوم؛ ارزیابی بازتولیدپذیر یادگیری ماشین
  روی داده‌های برچسب‌دار.

## اجزای مخزن

| مسیر | جزء | زبان | نقش |
|---|---|---|---|
| `services/ingestor` | سرویس مرجع Go | Go 1.23 | API دریافت، خط لولهٔ پردازش، قوانین، همبستگی، حادثه‌ها، SSE، متریک‌ها |
| `analytics` | بستهٔ تحلیل | Python 3.12 | خط پایهٔ EWMA، Isolation Forest، ارزیابی بازتولیدپذیر، آداپتور LLM، سرویس همراه HTTP |
| `native/parser` | پارسر بومی | C++20 | تجزیه/اعتبارسنجی سخت‌گیرانهٔ JSON رخداد با C ABI (شتاب‌دهی اختیاری) |
| `web` | کنسول StreamGuard | TypeScript/React (Next.js) | رابط بررسی ۱۴ بخشی؛ نسخهٔ دمو (موتور تعبیه‌شده) یا حالت Go-backed |
| `deploy/docker` + `docker-compose.yml` | استقرار | Docker | کل مجموعه: PostgreSQL + Go + سرویس همراه تحلیل + کنسول |
| `docs` | مستندات | EN + FA (فارسی) | معماری، راهنماها، تصاویر و GIF‌ها |
| `.github/workflows` | CI/CD | GitHub Actions | تست، sanitizer، اسکن امنیتی، کانتینر، E2E، انتشار |

## شروع سریع

### روش A — کل مجموعه با Docker Compose

```bash
docker compose up --build
# Console (Go-backed mode):  http://localhost:3000
# Go API health:             http://localhost:8080/api/health
# Analytics sidecar:         http://localhost:8090/health
```

### روش B — سرویس Go از سورس

```bash
cd services/ingestor
go build ./...
go run ./cmd/ingestor            # :8080, in-memory store (no POSTGRES_DSN)
# in another shell — generate a deterministic attack scenario:
go run ./cmd/sggen --scenario brute_force --url http://127.0.0.1:8080 --key sg-demo-ingest-key-2026
```

با PostgreSQL:

```bash
POSTGRES_DSN=postgres://user:pass@host:5432/db go run ./cmd/ingestor
```

(مهاجرت‌های شِما در زمان راه‌اندازی به‌صورت خودکار اعمال می‌شوند.)

### روش C — کنسول دموی مستقل (خودکفا)

```bash
cd web
bun install
bun run db:push && bun run seed   # SQLite + ~4-5h of seeded history via the engine
bun run dev                        # http://localhost:3000
# live-stream relay (socket.io):
cd mini-services/stream && bun run dev
```

### کاربران دمو (سطح دمو، seed شده)

| نام کاربری | گذرواژه | نقش |
|---|---|---|
| `admin` | `admin123` | ADMIN — همه‌چیز: تنظیمات، ممیزی، بازنشانی |
| `analyst` | `analyst123` | ANALYST — تحقیق، قوانین، حادثه‌ها، هوش مصنوعی |
| `viewer` | `viewer123` | VIEWER — فقط خواندنی |

کلید دریافت دمو برای مسیر HTTP: `sg-demo-ingest-key-2026` (در هدر `X-Ingest-Key`).

## پیکربندی (خلاصه)

متغیرهای اصلی سرویس Go: `PORT`، `POSTGRES_DSN`، `SESSION_SECRET`، `INGEST_KEY`،
`RATE_LIMIT_PER_MIN`، `MAX_BATCH`، `RETENTION_HOURS`، `CORRELATION_WINDOW_SECONDS`،
`LLM_BASE_URL`، `LLM_MODEL`، `ANALYTICS_URL`. جدول کامل با مقادیر پیش‌فرض و شرح هر
متغیر در [INSTALLATION_FA.md](INSTALLATION_FA.md) آمده است.

## نقشهٔ راه مستندات فارسی

| سند | موضوع |
|---|---|
| [INSTALLATION_FA.md](INSTALLATION_FA.md) | نصب، پیش‌نیازها، Docker Compose، متغیرهای محیطی، عیب‌یابی |
| [USER_GUIDE_FA.md](USER_GUIDE_FA.md) | راهنمای کاربر کنسول: ورود، نقش‌ها، ۱۴ بخش، جست‌وجو، میان‌برها |
| [ARCHITECTURE_FA.md](ARCHITECTURE_FA.md) | معماری پیاده‌شده، نسخه‌ها، معناشناسی پردازش، به‌روزرسانی زنده |
| [EVENT_SCHEMA_FA.md](EVENT_SCHEMA_FA.md) | شِمای رخداد نسخه ۱، enumها، اعتبارسنجی، توان‌نمایی |
| [API_FA.md](API_FA.md) | جدول کامل endpointها، کدهای خطا، صفحه‌بندی، SSE، مثال curl |
| [DETECTION_RULES_FA.md](DETECTION_RULES_FA.md) | ۷ قانون seed‌شده، ویرایش زمان اجرا، ممیزی قانون، سناریوهای شبیه‌ساز |
| [INCIDENT_RESPONSE_FA.md](INCIDENT_RESPONSE_FA.md) | چرخهٔ عمر حادثه، همبستگی، یادداشت‌ها، گزارش AI مشورتی |
| [MACHINE_LEARNING_FA.md](MACHINE_LEARNING_FA.md) | EWMA، Isolation Forest، ارزیابی بازتولیدپذیر، نتایج واقعی |
| [LOCAL_AI_FA.md](LOCAL_AI_FA.md) | دستیار تحقیق محلی، پیکربندی Ollama، مرزهای امنیتی |
| [SECURITY_FA.md](SECURITY_FA.md) | گزارش آسیب‌پذیری، مدل تهدید، نکات دمو |
| [DEVELOPMENT_FA.md](DEVELOPMENT_FA.md) | محیط توسعه، قواعد کد، ساخت/تست، مشارکت |
| [TESTING_FA.md](TESTING_FA.md) | فلسفهٔ تست، نتایج واقعی، باگ‌هایی که تست‌ها پیدا کردند |
| [RELEASE_FA.md](RELEASE_FA.md) | نسخه‌بندی مرحله‌ای، فرایند انتشار، آرتیفکت‌ها |

## کنسول در حرکت

تصاویر از برنامهٔ واقعی در حال اجرا گرفته شده‌اند (نسخهٔ دمو، دادهٔ شبیه‌ساز — با برچسب «دادهٔ شبیه‌ساز» در همه‌جای رابط کاربری):

| رخداد زندهٔ حمله روی دیوار رویدادها | سه‌بندی رخداد و چرخهٔ عمر |
|---|---|
| ![حملهٔ زنده](../assets/demo-live-attack.gif) | ![سه‌بندی رخداد](../assets/demo-incident-triage.gif) |
| **تحقیق با کمک هوش مصنوعی** (گزارش مبتنی بر شواهد) | **کنسول دو‌زبانه** (انگلیسی ⇆ فارسی با RTL کامل) |
| ![تحقیق AI](../assets/demo-ai-investigation.gif) | ![تغییر زبان](../assets/demo-language-toggle.gif) |

تصاویر بخش‌ها: [نمای کلی](../assets/01-overview.png) · [جریان زنده](../assets/02-live-stream.png) · [کاوشگر رخداد](../assets/03-event-explorer.png) · [قوانین تشخیص](../assets/04-detection-rules.png) · [صف رخداد](../assets/05-incident-queue.png) · [بررسی رخداد](../assets/06-incident-investigation.png) · [تحلیل ML](../assets/07-ml-analytics.png) · [دستیار AI](../assets/08-ai-assistant.png) · [سلامت سیستم](../assets/09-system-health.png) · [منابع دریافت](../assets/10-sources.png)

## مستندات انگلیسی

مستندات مرجع انگلیسی در ریشهٔ مخزن: [README.md](../../README.md)،
[ARCHITECTURE.md](../../ARCHITECTURE.md)، [SECURITY.md](../../SECURITY.md)،
[CONTRIBUTING.md](../../CONTRIBUTING.md) و README هر جزء:
[services/ingestor](../../services/ingestor/README.md)،
[analytics](../../analytics/README.md)،
[native/parser](../../native/parser/README.md) و
[web](../../web/README.md).

## محدودیت‌ها (صادقانه)

- ذخیره‌ساز درون‌حافظه‌ای سرویس Go پایا نیست؛ برای ماندگاری از PostgreSQL استفاده کنید.
- ارقام ارزیابی یادگیری ماشین از سناریوهای ساختگیِ برچسب‌دار است، نه ترافیک واقعی؛ این
  اعداد بازتولیدپذیری و موازنهٔ روش‌ها را نشان می‌دهند، نه دقت عملیاتی.
- تست‌های یکپارچگی PostgreSQL فقط در CI اجرا می‌شوند (در sandbox توسعه Docker موجود
  نبود).
- پارسر C++ در سرویس Go یکپارچه‌سازیِ اختیاری با build tag است؛ پارسر پیش‌فرض Go خالص
  است.
- اعتبارنامه‌های دمو به‌طور عمدی ضعیف و برچسب‌دارند — نسخهٔ دمو برای ارزیابی است، نه
  استفادهٔ عملیاتی.

## مجوز

StreamGuard — Copyright © 2026 Parsa Fathi. مجوز Apache نسخهٔ ۲.۰
([LICENSE](../../LICENSE)). اطلاع‌رسانی شخص ثالث: `THIRD_PARTY_NOTICES.md`.
