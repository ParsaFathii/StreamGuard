<!-- Copyright © 2026 Parsa Fathi — Apache-2.0 -->

# معماری StreamGuard (نسخهٔ فارسی)

این سند معماری را **همان‌گونه که پیاده شده** توصیف می‌کند. هر جا جزئی اختیاری یا
مخصوص یک نسخه است، صریحاً ذکر می‌شود. کد دیاگرام‌ها عیناً از نسخهٔ انگلیسی کپی شده است
(رندر GitHub فقط با متن انگلیسی دیاگرام‌ها درست کار می‌کند)؛ توضیحات فارسی است.

نسخهٔ انگلیسی: [ARCHITECTURE.md](../../ARCHITECTURE.md) — مطالعهٔ مرتبط:
[README_FA.md](README_FA.md).

## ۱. نمای کل سامانه

StreamGuard یک سکوی دریافت، پردازش، پایش و تحلیل امنیتی رخداد لحظه‌ای است با سه
پس‌زمینهٔ قابل تست که یک قرارداد مشترک دارند:

- **سرویس مرجع Go** (`services/ingestor`) — API عملیات‌گرا: دریافت، اعتبارسنجی، خط لولهٔ
  کران‌دار، قوانین تشخیص، همبستگی، مدیریت حادثه، به‌روزرسانی زندهٔ SSE و متریک‌ها.
  PostgreSQL برای پایایی (ذخیره‌ساز درون‌حافظه‌ای برای تست و اجرای موقت).
- **بستهٔ تحلیل Python** (`analytics`) — خط پایهٔ آماری، Isolation Forest، ارزیابی
  بازتولیدپذیر روی دادهٔ ساختگیِ برچسب‌دار و آداپتور LLM محلی اختیاری. به‌صورت سرویس
  همراه (HTTP) یا کتابخانه/CLI اجرا می‌شود.
- **کنسول وب** (`web`) — اپلیکیشن تک‌صفحه‌ای React/TypeScript (Next.js) در دو حالت:
  **نسخهٔ دموی کنسول** (موتور تعبیه‌شده روی SQLite — پیش‌فرض، کاملاً خودکفا) و
  **حالت Go-backed** (همان UI رو به سرویس Go با `NEXT_PUBLIC_API_BASE` و انتقال SSE).

کتابخانهٔ C++20 (`native/parser`) یک جزء تجزیه/اعتبارسنجی پرسرعت اختیاری با C ABI پایدار
است که از طریق build tag به سرویس Go وصل می‌شود (پارسر پیش‌فرض، Go خالص است).

```mermaid
flowchart TB
    subgraph Sources[Event Sources]
        GEN[sggen deterministic generator / simulator scenarios]
        EXT[External senders via POST /api/ingest + X-Ingest-Key]
    end
    subgraph GoService[services/ingestor — Go]
        API[HTTP API — auth/RBAC, ingest, query, incidents, AI, metrics]
        VAL[Validation and Normalization]
        PIPE[Bounded queue + worker pool pipeline]
        RULES[Detection rule engine — 7 seeded rules]
        CORR[Correlation engine]
        INC[Incident manager + lifecycle]
        SSE[SSE hub — live updates]
        STORE[(Store interface)]
    end
    PG[(PostgreSQL)] 
    MEM[(In-memory store — tests/ephemeral)]
    subgraph AnalyticsSidecar[analytics — Python]
        BASE[EWMA baselines + z-score]
        IFOREST[Isolation Forest]
        EVAL[Reproducible evaluation]
        LLMAD[Local LLM provider adapter — Ollama-compatible]
    end
    WEB[web console — React/TypeScript]
    subgraph ConsoleDemo[Console demo edition — embedded engine]
        DAPI[Next.js API routes]
        DENG[TS engine: rules, correlation, incidents, ML]
        DB[(SQLite via Prisma)]
        WS[socket.io relay service]
    end
    LLM[Optional local LLM — Ollama]

    GEN --> API
    EXT --> API
    API --> VAL --> PIPE
    PIPE --> RULES --> CORR --> INC
    PIPE --> SSE
    INC --> SSE
    STORE --> PG
    STORE --> MEM
    API --> STORE
    API -.->|ANALYTICS_URL sidecar| AnalyticsSidecar
    API --> LLMAD
    LLMAD --> LLM
    WEB -->|Go-backed mode| API
    WEB -->|SSE| SSE
    WEB ==>|default: demo edition| ConsoleDemo
```

## ۲. دو نسخهٔ کنسول (صریح)

| | نسخهٔ دموی کنسول (`web`، پیش‌فرض) | نسخهٔ مرجع Go |
|---|---|---|
| هدف | ارزیابی، آموزش و دموی رفتار کامل محصول | استقرار عملیات‌گرا |
| پس‌زمینه | مسیرهای API نکست‌جی‌اس (TypeScript) تعبیه‌شده در کنسول | `services/ingestor` (Go) + PostgreSQL |
| ذخیره‌ساز | SQLite با Prisma | PostgreSQL (یا درون‌حافظه‌ای، غیرپایا) |
| به‌روزرسانی زنده | سرویس رلهٔ socket.io (`mini-services/stream`) | SSE (`GET /api/stream`) |
| سرویس‌دهندهٔ AI | سرویس‌دهندهٔ sandbox از طریق `z-ai-web-dev-sdk` (فقط سمت سرور) | هر endpoint سازگار با Ollama |
| یادگیری ماشین | پورت TS همان روش‌ها (EWMA + Isolation Forest، همان پارامترها) | بستهٔ Python با سرویس همراه، یا پیاده‌سازی Go همان روش‌ها |

هر دو نسخه همان قرارداد داده/API را پیاده می‌کنند، پس UI کنسول با هر دو کار می‌کند.
نسخهٔ دمو همهٔ دادهٔ شبیه‌ساز را `origin=synthetic` برچسب می‌زند.

## ۳. چرخهٔ عمر رخداد و معناشناسی پردازش

```mermaid
stateDiagram-v2
    [*] --> Accepted: POST /api/ingest (auth + rate limit)
    Accepted --> Validated: schema check passed
    Accepted --> Rejected: schema violation (recorded, never silent)
    Validated --> Stored: persisted (idempotent by event_id)
    Stored --> Processed: rules evaluated, latency recorded
    Processed --> Detection: rule matched (threshold/window/cooldown)
    Detection --> Incident: new or correlated open incident
    Rejected --> [*]
    Incident --> [*]
```

تضمین‌های مستندشده:

- **Accepted** یعنی درخواست از احراز هویت، محدودیت نرخ، سقف‌های اندازه و شکل JSON عبور
  کرده — نه اینکه پردازش پایین‌دستی تمام شده باشد.
- **توان‌نمایی:** `event_id` تکراری با شمارندهٔ `duplicates` پذیرفته می‌شود؛ دوباره ذخیره
  یا پردازش نمی‌شود.
- خط لوله داخل یک فرایند «حداقل یک‌بار» است؛ ادعای exactly-once بین ری‌استارت‌ها برای
  ذخیره‌ساز درون‌حافظه‌ای وجود ندارد. با PostgreSQL درج رخداد تراکنشی و با کلید اصلی
  توان‌نما است.
- **رخداد دیررس/بی‌ترتیب:** با پنجره‌های زمانِ «زمان دریافت» پردازش می‌شوند؛ رخدادی که
  بعد از پنجرهٔ همبستگی به حادثه می‌چسبد با پرچم `late` مشخص می‌شود.
- **خطای اعتبارسنجی** ثبت می‌شود (دلیل + نمونهٔ بریده‌شده ≤ ۲۵۶ بایت) و قانون
  SG-RULE-007 را تغذیه می‌کند.

## ۴. خط لولهٔ دریافت (Go)

```mermaid
flowchart LR
    REQ[POST /api/ingest] --> AUTH[session or X-Ingest-Key + rate limit 60/min]
    AUTH --> LIMIT[MaxBytesReader 256KB, batch <= 100]
    LIMIT --> PARSE[parse + strict validation]
    PARSE -->|reject| VF[ValidationFailure record]
    PARSE -->|ok| Q[Bounded queue — capacity 1024]
    Q --> W[Worker pool — GOMAXPROCS bounded, 2..16]
    W --> P[(PostgreSQL — idempotent insert)]
    W --> R[Rule engine]
    R --> C[Correlation]
    C --> I[Incident manager]
    W --> S[SSE emit event:new]
    R --> S
    C --> S
    I --> S
```

- فشار معکوس: صف پر، به‌جای رشد بی‌کران، درخواست دریافت را با `429` + `Retry-After` رد
  می‌کند.
- خاموشی منظم: توقف پذیرش → تخلیهٔ صف با بودجهٔ ۱۰ ثانیه → بستن وابستگی‌ها.
- تمام SQL پارامتری است؛ هیچ جایی رشته‌ای به‌هم چسبانده نمی‌شود.

## ۵. قوانین، همبستگی و حادثه‌ها

هفت قانون قطعی seed شده‌اند (SG-RULE-001..007). هر قانون: شناسهٔ پایدار، انتخابگر، شرط
(count/ratio/sequence/exists)، آستانه + پنجره، شدت، فروکش، فرونشانی، نسخه و تاریخچهٔ
ممیزی تغییرات.

```mermaid
flowchart TB
    E[Processed events] --> R{Rule engine — selector match?}
    R -->|threshold/window met| CD{Within cooldown for rule+key?}
    CD -->|yes| SUP[Suppressed — no duplicate detection]
    CD -->|no| D[Detection created]
    D --> K{Open incident with same ruleId + correlationKey within window?}
    K -->|yes| ATT[Attach events, bump severity/timestamps]
    K -->|no| NEW[New incident INC-00000N]
```

کلید همبستگی: `actor` برای قوانین احراز هویت و `source_id` برای قوانین نرخ/خطا؛ مشتق
کلید هر قانون در جدول قوانین مستند شده است. چرخهٔ عمر حادثه فقط با انتقال‌های
اعتبارسنجی‌شده:

```mermaid
stateDiagram-v2
    NEW --> TRIAGED
    NEW --> INVESTIGATING
    NEW --> RESOLVED
    NEW --> CLOSED
    TRIAGED --> INVESTIGATING
    TRIAGED --> RESOLVED
    TRIAGED --> CLOSED
    INVESTIGATING --> RESOLVED
    INVESTIGATING --> CLOSED
    INVESTIGATING --> TRIAGED
    RESOLVED --> CLOSED
    RESOLVED --> INVESTIGATING: reopen
    CLOSED --> INVESTIGATING: reopen (ADMIN)
```

هر انتقال، واگذاری و راه‌حل با عامل + مهر زمانی ثبت می‌شود (رد ممیزی). حل‌کردن به
خلاصهٔ راه‌حل (حداقل ۱۰ نویسه) نیاز دارد. گزارش هوش مصنوعی هرگز وضعیت حادثه را عوض
نمی‌کند.

## ۶. مرز تحلیل و یادگیری ماشین

```mermaid
flowchart LR
    subgraph Features[Per-minute, per-source feature vectors]
        F1[rate]
        F2[error ratio]
        F3[failed-auth ratio]
        F4[unique actors]
        F5[avg severity weight]
    end
    F --> Z[EWMA baseline + one-sided z-score, alpha 0.3, z>3]
    F --> IF[Isolation Forest — 100 trees, psi 64, depth 8, threshold 0.61, seed 42]
    Z --> OUT[anomaly timeline + per-source baselines]
    IF --> OUT
    DS[Labeled synthetic datasets — known ground truth] --> EV[Evaluation: precision/recall/F1/FPR + confusion per method]
    Z --> EV
    IF --> EV
    RULES2[Deterministic rules] --> EV
```

- همان پارامترهای روش‌ها هم در بستهٔ Python و هم در نسخهٔ دموی کنسول (پورت TS) پیاده
  شده‌اند — نتیجه با seed داده‌شده قطعی است.
- ارزیابی روی **سناریوهای ساختگیِ برچسب‌دار** اجرا می‌شود؛ اعداد به‌عنوان نتیجهٔ ارزیابی
  گزارش می‌شوند، نه ادعای دقت عملیاتی. نقطه‌کورهای هر روش صادقانه مستند شده‌اند (z-score
  پس از شروع، تغییرات پایدار را جذب می‌کند؛ قوانین ناهنجاریِ فقط‌تأخیری را نمی‌بینند؛
  Isolation Forest با ابرِ نرمالِ پهن، ناهنجاری را از دست می‌دهد).
- نسخهٔ مدل با هر اجرای ارزیابی و هر یافتهٔ ML که به UI می‌رسد ثبت می‌شود.

## ۷. دستیار تحقیق — استوار بر شواهد و مرزهای امنیتی

```mermaid
flowchart TB
    U[Analyst requests investigation] --> EB[Evidence bundle assembly<br/>incident + <=50 events + rule definitions + ML context]
    EB --> SP[Strict system prompt:<br/>facts vs hypotheses, no invention,<br/>event text = UNTRUSTED DATA]
    EB --> WRAP[Untrusted-data wrapping of event messages]
    SP --> LLM[Local LLM — Ollama-compatible]
    WRAP --> LLM
    LLM --> VAL[JSON schema validation of response]
    VAL -->|invalid| ERR[503 honest error — system stays fully usable]
    VAL -->|ok| REP[Structured report: facts / rule findings / ML findings / hypotheses / next steps / references]
    REP --> STORE2[Stored as read-only advisory report]
```

مرزهای امنیتی اعمال‌شده (نوعی، نه شعاری): دستیار فقط مشورتی است؛ چیزی اجرا نمی‌کند،
به هیچ رمزی دسترسی ندارد، قوانین و حادثه‌ها را تغییر نمی‌دهد، متن رخداد را همیشه به‌عنوان
«داده» می‌بیند (مقاوم به تزریق دستور بر اساس ساختار — تلاش‌های تزریق داخل بلوک غیرمطمئن
می‌مانند) و وضعیت/خطای سرویس‌دهنده صادقانه گزارش می‌شود. fallback ابری وجود ندارد: اگر
سرویس‌دهندهٔ محلی در دسترس نباشد، قابلیت خطا برمی‌گرداند و همه‌چیز دیگر کار می‌کند.

## ۸. به‌روزرسانی زنده

- نسخهٔ Go: SSE (`GET /api/stream`) با کانال‌های `event:new` (دسته‌ای)، `detection:new`،
  `incident:new`، `incident:update`، `stats` و `simulator`؛ keepalive هر ۱۵ ثانیه؛
  کانال بافرشده به‌ازای کلاینت با سیاست «قدیمی‌ترین را بینداز» در سرریز؛ بازپخش
  `Last-Event-ID`.
- نسخهٔ دموی کنسول: رلهٔ socket.io؛ پس‌زمینهٔ Next.js به `/emit` داخلیِ رله POST می‌کند
  (سرور به سرور).
- UI حالت‌های زنده / کهنه (بیش از ۱۵ ثانیه بدون پیام) / در حال اتصال مجدد / قطع را از
  هم تفکیک می‌کند و با هر پیام، کوئری‌های متأثر را نامعتبر می‌کند.

## ۹. پایایی، نگهداشت و ممیزی

- شِمای PostgreSQL (مهاجرت‌ها زیر advisory lock در راه‌اندازی): users، sessions، ingest
  keys، events (کلید توان‌نما)، validation failures، rules + rule audit، detections،
  incidents + events + notes + status history، audit log، ML runs، AI reports، settings.
- نگهداشت: TTL پیکربندی‌شدنی (پیش‌فرض ۷۲ ساعت). رخدادهای متصل به حادثهٔ غیربسته هرگز
  حذف نمی‌شوند. هر اجرای نگهداشت ممیزی و شمارش می‌شود.
- ممیزی: رد ضمیمه‌شدنی (append-only) برای ورود/خروج، تغییر قوانین، انتقال حادثه/یادداشت، تحقیق AI،
  اجرای شبیه‌ساز، تغییر تنظیمات و اجرای نگهداشت. endpoint پرس‌وجو فقط ADMIN با پالایش‌های
  اعتبارسنجی‌شده.

## ۱۰. معماری امنیت

- احراز هویت سمت سرور (bcrypt + نشست‌های opaque با کوکی HMAC) و RBAC
  (ADMIN/ANALYST/VIEWER) روی همهٔ endpointها — UI هرگز خط دفاعی نهایی نیست.
- دریافت: نشست یا کلید دریافت؛ محدودیت نرخ پنجرهٔ لغزان به‌ازای کلید/کاربر (پیش‌فرض
  ۶۰/دقیقه)؛ سقف ۲۵۶ KB بدنه / ۴ KB رخداد / ۱۰۰ رخداد در batch.
- اعتبارسنجی ورودی همه‌جا (شِمای سخت‌گیرانه، enumها، اندازه‌های کران‌دار)؛ خطاها ثبت
  می‌شوند و هرگز بی‌سرو صدا دور ریخته نمی‌شوند.
- SQL فقط پارامتری؛ رمزها از لاگ حذف می‌شوند (هدرهای authorization، کوکی‌ها، کلیدهای
  دریافت) و در هیچ پاسخی رمزی وجود ندارد.
- جدول کامل مدل تهدید: [SECURITY_FA.md](SECURITY_FA.md).

## ۱۱. خط لولهٔ انتشار

```mermaid
flowchart LR
    DEV[main branch] --> CI[GitHub Actions ci.yml:<br/>go race tests, postgres integration,<br/>C++ tests+sanitizers, python determinism,<br/>web lint+typecheck+build, security scans,<br/>container builds, E2E job]
    CI -->|green| TAG[version tag vN.N.N]
    TAG --> REL[release.yml: tag matches CHANGELOG,<br/>full test suite, multi-platform binaries,<br/>parser artifacts, python sdist, SHA256SUMS, SBOM]
    REL --> GH[GitHub Release]
```

یک تست الزامیِ ناموفق، انتشار را بلاک می‌کند. جزئیات در [RELEASE_FA.md](RELEASE_FA.md).

## ۱۲. محدودیت‌های شناخته‌شده (صادقانه)

- ذخیره‌ساز درون‌حافظه‌ای Go پایا نیست (مستند؛ مسیر عملیاتی PostgreSQL است).
- تست‌های یکپارچگی PostgreSQL فقط در CI اجرا می‌شوند (در sandbox توسعه Docker وجود
  نداشت).
- ارزیابی ML روی سناریوهای ساختگیِ برچسب‌دار است؛ هیچ ادعای دقت روی ترافیک واقعی وجود
  ندارد.
- کیفیت دستیار AI به مدل محلیِ تنظیم‌شده بستگی دارد؛ سامانه وضعیت سرویس‌دهنده را صادقانه
  گزارش می‌کند و بدون آن هم کامل کار می‌کند.
- یکپارچه‌سازی پارسر C++ در سرویس Go اختیاری است (build tag)؛ پارسر Go خالص، پیش‌فرض
  است.
