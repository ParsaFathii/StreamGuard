<!-- Copyright © 2026 Parsa Fathi — Apache-2.0 -->

# مرجع API — StreamGuard (نسخهٔ فارسی)

خلاصهٔ کامل API پلتفرم. قرارداد کامل در مستندات انگلیسی آمده است:
[README.md](../../README.md) §API، [ARCHITECTURE.md](../../ARCHITECTURE.md) و README
[services/ingestor](../../services/ingestor/README.md). مطالعهٔ مرتبط فارسی:
[EVENT_SCHEMA_FA.md](EVENT_SCHEMA_FA.md).

## قراردادهای عمومی

- همهٔ پاسخ‌ها JSON هستند و همهٔ مهرهای زمانی ISO 8601 UTC.
- خطاها به شکل `{"error": {"code": "MACHINE_CODE", "message": "..."}}` با وضعیت HTTP
  مناسب برمی‌گردند.
- احراز هویت با کوکی `sg_session` (HttpOnly، امضاشده با HMAC) یا `Authorization: Bearer`.
  دریافت رخداد همچنین با هدر `X-Ingest-Key` ممکن است.
- صفحه‌بندی فهرست‌ها: `{"data": [...], "page": n, "pageSize": n, "total": n}` —
  پیش‌فرض ۲۵ آیتم در صفحه، سقف ۱۰۰.
- همهٔ پاسخ‌ها هدر `X-StreamGuard-Version` دارند.

## جدول endpointها

| متد | مسیر | نقش لازم | توضیح |
|---|---|---|---|
| POST | `/api/auth/login` | — | ورود؛ ست‌کردن کوکی نشست؛ ممیزی |
| POST | `/api/auth/logout` | نشست | خروج؛ ممیزی |
| GET | `/api/auth/session` | نشست | کاربر جاری |
| POST | `/api/ingest` | ADMIN/ANALYST یا `X-Ingest-Key` | دریافت تک‌رخداد یا `{batch:[...]}` |
| GET | `/api/events` | همهٔ نقش‌ها | فهرست رخدادها با همهٔ پالایش‌ها |
| GET | `/api/events/{id}` | همهٔ نقش‌ها | جزئیات کامل یک رخداد |
| GET | `/api/rules` | همهٔ نقش‌ها | قوانین + شعله‌های ۲۴س + آخرین اجرا |
| PATCH | `/api/rules/{id}` | ANALYST+ | ویرایش آستانه/پنجره/فروکش/شدت/فعال؛ نسخه بالا می‌رود؛ ممیزی |
| GET | `/api/rules/{id}/audit` | ADMIN | تاریخچهٔ تغییرات قانون |
| GET | `/api/detections` | همهٔ نقش‌ها | فهرست تشخیص‌ها با پالایش |
| GET | `/api/incidents` | همهٔ نقش‌ها | فهرست حادثه‌ها با پالایش/مرتب‌سازی |
| GET | `/api/incidents/{id}` | همهٔ نقش‌ها | جزئیات + رخدادها + تشخیص‌ها + یادداشت‌ها + تاریخچهٔ وضعیت |
| PATCH | `/api/incidents/{id}` | ANALYST+ | انتقال چرخهٔ عمر/واگذاری/راه‌حل (اعتبارسنجی‌شده) |
| POST | `/api/incidents/{id}/notes` | ANALYST+ | افزودن یادداشت (≤ ۴۰۰۰ نویسه) |
| GET | `/api/incidents/{id}/events` | همهٔ نقش‌ها | رخدادهای حادثه، صفحه‌بندی‌شده |
| GET | `/api/analytics/overview` | همهٔ نقش‌ها | شاخص‌های کلان + سلامت |
| GET | `/api/analytics/timeseries` | همهٔ نقش‌ها | سری زمانی events/detections/rejected |
| GET | `/api/analytics/ml` | همهٔ نقش‌ها | خط زمانی ناهنجاری + خطوط پایهٔ منابع |
| POST | `/api/analytics/ml/evaluate` | ANALYST+ | ارزیابی بازتولیدپذیر (seed ثابت) |
| POST | `/api/ai/investigate` | ANALYST+ (و فعال‌بودن AI) | گزارش تحقیق ساختاریافته |
| GET | `/api/simulator/scenarios` | ANALYST+ | فهرست سناریوها |
| POST | `/api/simulator/scenario` | ANALYST+ | اجرای سناریو (قطعی، seed اختیاری) |
| POST | `/api/simulator/tick` | ANALYST+ | تولید فعالیت نرمال (۱..۵۰ رخداد) |
| POST | `/api/simulator/reset` | ADMIN | بازنشانی داده‌های دمو؛ ممیزی |
| GET | `/api/sources` | همهٔ نقش‌ها | منابع مشتق‌شده از رخدادهای واقعی |
| GET | `/api/health` | همهٔ نقش‌ها | وضعیت و نسخه و صف |
| GET | `/api/metrics` | همهٔ نقش‌ها | متن Prometheus |
| GET | `/api/audit` | ADMIN | تاریخچهٔ ممیزی با پالایش اعتبارسنجی‌شده |
| GET | `/api/settings` | همهٔ نقش‌ها | تنظیمات (بدون رمز) |
| PATCH | `/api/settings` | ADMIN | تغییر تنظیمات؛ ممیزی |
| POST | `/api/system/retention-run` | ADMIN | اجرای نگهداشت؛ ممیزی |
| GET | `/api/stream` | نشست (نسخهٔ Go) | جریان زندهٔ SSE |

## شکل پاسخ‌ها (نمونه‌های کلیدی)

- دریافت موفق:

```json
{
  "accepted": 2, "duplicates": 1, "rejected": 2,
  "eventIds": ["..."],
  "duplicateIds": ["..."],
  "rejectedItems": [{"index": 3, "reason": "severity not in enum"}]
}
```

- جزئیات حادثه: `events` (۲۰۰ مورد اول)، `detections`، `notes`، `aiReports` (فقط
  شناسه/زمان) و `statusHistory` از هر انتقال.
- گزارش AI: `report` شامل `summary`، `facts[]`، `ruleFindings[]`، `mlFindings[]`،
  `hypotheses[]`، `nextSteps[]` و `references` + `provider` و `durationMs`.

## صفحه‌بندی

پارامترهای `page` و `pageSize` (پیش‌فرض ۲۵، سقف ۱۰۰) روی همهٔ فهرست‌ها؛ پاسخ همیشه
`total` دارد. `timeseries` و `scenarios` و `sources` طبق قرارداد، آرایهٔ خام برمی‌گردانند.

## کدهای خطا

| کد | کد ماشین | شرح |
|---|---|---|
| 400 | `INVALID_JSON` / `INVALID_FILTER` / `INVALID_REQUEST` / `UNKNOWN_DATASET` / `RESOLUTION_REQUIRED` | بدنهٔ بد، پالایش نامعتبر (پیام، پارامتر خطادار را نام می‌برد)، خلاصهٔ راه‌حل جاافتاده |
| 401 | `INVALID_CREDENTIALS` / `UNAUTHORIZED` | گذرواژه غلط، نشست/کلید دریافت نامعتبر |
| 403 | `FORBIDDEN` | نقش کافی نیست (RBAC سمت سرور) |
| 404 | `NOT_FOUND` | مسیر یا شناسهٔ موجود نیست |
| 409 | `INVALID_TRANSITION` (نسخهٔ Go) | انتقال وضعیت حادثهٔ نامعتبر |
| 413 | `PAYLOAD_TOO_LARGE` | بدنه > ۲۵۶ KB یا batch > ۱۰۰ |
| 429 | `RATE_LIMITED` (+`Retry-After`) | تجاوز از سقف ۶۰/دقیقه یا صف پر |
| 503 | `AI_DISABLED` / خطای سرویس‌دهنده | هوش مصنوعی خاموش یا سرویس‌دهنده در دسترس نیست — بدون fallback ابری |

نکتهٔ نسخه‌ها: در سرویس Go انتقال نامعتبر حادثه `409 INVALID_TRANSITION` برمی‌گرداند؛
پس‌زمینهٔ دموی کنسول همان شرایط را `400 INVALID_TRANSITION` می‌دهد. هر دو سرور انتقال را
رد می‌کنند — فقط کد HTTP متفاوت است.

## مثال curl — ورود

```bash
curl -c cookies.txt -X POST http://localhost:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"analyst","password":"analyst123"}'
```

## مثال curl — دریافت رخداد

```bash
curl -X POST http://localhost:8080/api/ingest \
  -H 'content-type: application/json' \
  -H 'X-Ingest-Key: sg-demo-ingest-key-2026' \
  -d '{"batch":[{"event_id":"11111111-2222-4333-8444-555555555555","schema_version":1,"event_time":"2026-01-15T10:30:00Z","source_id":"sim-app-01","source_type":"app","severity":"info","category":"application","message":"healthcheck ok"}]}'
# → 202 {"accepted":1,"duplicates":0,"rejected":0,"eventIds":[...]}
```

پاسخ `202` یعنی «پذیرفته و ذخیره شد»؛ اثباتِ «ارزیابی قانون تمام شد» نیست — برای آن به
تشخیص‌ها/حادثه‌ها یا جریان زنده نگاه کنید.

## SSE و کانال‌ها

`GET /api/stream` (نسخهٔ Go) — کانال‌ها:

| کانال | محتوا |
|---|---|
| `event:new` | دستهٔ رخدادها: `{"events":[...],"count":N,"ts":"..."}` (با ردیف‌های فشرده) |
| `detection:new` | خلاصهٔ تشخیص تازه |
| `incident:new` / `incident:update` | خلاصهٔ حادثه |
| `stats` | شمارنده‌های کلیان (هر ۵ ثانیه) |
| `simulator` | `{runId, scenarioId, phase}` |

keepalive هر ۱۵ ثانیه؛ `Last-Event-ID` پیام‌های اخیر را بازپخش می‌کند؛ در سرریز،
قدیمی‌ترین پیام هر کلاینت انداخته می‌شود. نسخهٔ دموی کنسول همین شکل‌های payload را روی
socket.io می‌فرستد، پس UI با هر دو انتقال یکی کار می‌کند.

ادامهٔ مطالعه: [DETECTION_RULES_FA.md](DETECTION_RULES_FA.md) و
[INCIDENT_RESPONSE_FA.md](INCIDENT_RESPONSE_FA.md).
