<!-- Copyright © 2026 Parsa Fathi — Apache-2.0 -->

# قوانین تشخیص — StreamGuard (نسخهٔ فارسی)

هفت قانون قطعی به‌صورت پیش‌فرض seed می‌شوند. هر قانون در زمان اجرا قابل ویرایش است و
هر تغییر ممیزی می‌شود. نسخهٔ انگلیسی: [README.md](../../README.md) §Detection rules و
[ARCHITECTURE.md](../../ARCHITECTURE.md). مطالعهٔ مرتبط: [API_FA.md](API_FA.md) و
[USER_GUIDE_FA.md](USER_GUIDE_FA.md).

## مفاهیم پایه

هر قانون از این بخش‌ها ساخته شده است:

- **انتخابگر (selector):** کدام رخدادها اصلاً به این قانون مربوط‌اند — بر اساس `category`،
  `severity`، پیشوند `source_id` و یک جفت `attributes.{key,value}`.
- **شرط (condition):** نوع `count` (شمارش)، `ratio` (نسبت)، `sequence` (دنباله) یا
  `exists` (وقوع).
- **آستانه/پنجره:** شرط باید داخل پنجرهٔ زمانی برآورده شود؛ مثلاً «≥ ۵ در ۱۲۰ ثانیه».
- **فروکش (cooldown):** اگر همین قانون با همین کلید همبستگی به‌تازگی شعله زده باشد،
  تطبیق تکراری به‌جای تشخیص جدید، وضعیت `SUPPRESSED` می‌گیرد (فرونشانی تکرار).
- **کلید همبستگی:** معیار گروه‌بندی — `actor` برای قوانین احراز هویت و `source_id` برای
  قوانین نرخ/خطا.

## هفت قانون seed شده

| شناسه | نام | شرط | آستانه/پنجره | شدت | فروکش | کلید |
|---|---|---|---|---|---|---|
| SG-RULE-001 | Repeated Authentication Failures | ≥ ۵ ورود ناموفق برای یک عامل (category=auth، action=login_failed) | ۵ / ۱۲۰s | high | ۳۰۰s | actor |
| SG-RULE-002 | Abnormal Request Rate | > ۱۲۰ درخواست در دقیقه از یک منبع (category=network، kind=request) | ۱۲۰ / ۶۰s | medium | ۱۲۰s | source_id |
| SG-RULE-003 | Suspicious Auth Sequence | ≥ ۳ خطای احراز هویت و بعد موفقیت، برای یک عامل در ۵ دقیقه | ۳ خطا + ۱ موفق / ۳۰۰s | high | ۳۰۰s | actor |
| SG-RULE-004 | Error Rate Spike | نسبت خطا > ۳۰٪ با حداقل ۲۰ رخداد (category=application، شدت medium+ یا attributes.error) | ۰.۳۰ / ۳۰۰s | medium | ۳۰۰s | source_id |
| SG-RULE-005 | Repeated Authorization Failures | ≥ ۳ رد مجوز برای یک عامل (category=security، action=access_denied) | ۳ / ۳۰۰s | medium | ۳۰۰s | actor |
| SG-RULE-006 | Unexpected Configuration Change | تغییر پیکربندی روی منبع infra یا با پیشوند `prod-` (exists) | ۱ / ۰s | high | ۰s | source_id |
| SG-RULE-007 | Ingestion Validation Failures | ≥ ۱۰ رخداد ردشدهٔ اعتبارسنجی (داخلی) | ۱۰ / ۶۰s | low | ۶۰۰s | global |

## ویرایش قانون و تاریخچهٔ ممیزی

- ویرایش با `PATCH /api/rules/{id}` (نقش ANALYST و بالاتر) روی فیلدهای `enabled`،
  `threshold`، `windowSeconds`، `severity` و `cooldownSeconds` انجام می‌شود.
- بازه‌های مجاز سرور: آستانه ۱..۱۰۰۰۰، پنجره ۱۰..۳۶۰۰ ثانیه، فروکش ۰..۳۶۰۰ ثانیه؛
  مقادیر بیرونِ بازه با 400 رد می‌شوند.
- هر تغییر واقعی، نسخهٔ قانون (`version`) را یک عدد بالا می‌برد و یک رکورد `RuleAudit`
  می‌سازد؛ تاریخچه با `GET /api/rules/{id}/audit` (فقط ADMIN) قابل مطالعه است.
- تغییر بدون اثر (مقدار تکراری) نسخه را بالا نمی‌برد.
- «پیش‌نمایش انتخابگر» در کنسول فقط رخدادهای منطبق با انتخابگر را در ۲۴ ساعت اخیر نشان
  می‌دهد (اجرای خشک سمت کلاینت) — هیچ تشخیصی ساخته نمی‌شود و آستانه‌ها ارزیابی نمی‌شوند.

## سناریوهای شبیه‌ساز و قانون‌های مورد انتظار

شبیه‌ساز ده سناریوی قطعی دارد. `expectedDetections` هر سناریو طبق تعریف سرویس مرجع Go:

| سناریو | شرح | قوانین مورد انتظار | شدت حادثهٔ مورد انتظار |
|---|---|---|---|
| `clean_baseline` | ورودها/درخواست‌ها/heartbeat طبیعی بدون ناهنجاری | — | — |
| `brute_force` | ۸ ورود ناموفق برای یک عامل و بعد یک موفقیت | SG-RULE-001، SG-RULE-003 | high |
| `credential_stuffing` | ۴ عامل هرکدام با ۶ اعتبارنامهٔ سرقتی | SG-RULE-001 | high |
| `traffic_burst` | ۱۳۰ درخواست در یک دقیقه از یک منبع وب | SG-RULE-002 | medium |
| `latency_spike` | پاسخ‌های کند بدون خطا — هیچ قانونی شعله نمی‌زند (فقط ML) | — | — |
| `error_storm` | خطاهای بالای ۳۰٪ با حداقل ۲۰ رخداد | SG-RULE-004 | medium |
| `config_change` | تغییر پیکربندی روی یک منبع infra | SG-RULE-006 | high |
| `authz_failures` | ردهای مکرر access-denied برای یک عامل | SG-RULE-005 | medium |
| `malformed_batch` | ۱۲ رخداد نامعتبر که اعتبارسنجی رد می‌کند | SG-RULE-007 | low |
| `mixed_attack` | ترکیب brute force + توفان خطا + تغییر پیکربندی | SG-RULE-001، SG-RULE-003، SG-RULE-004، SG-RULE-006 | high |

نکتهٔ نسخه‌ها: موتور تعبیه‌شدهٔ نسخهٔ دموی کنسول برای `mixed_attack` فهرست کمی متفاوتی
دارد (SG-RULE-002 به‌جای SG-RULE-004)؛ هر دو موتور همان قوانین پایه را با همان
پارامترها اجرا می‌کنند و این تفاوت در تعریف سناریوست، نه در موتور قوانین.

## مراحل بعدی

- چطور تشخیص‌ها به حادثه همبسته می‌شوند: [INCIDENT_RESPONSE_FA.md](INCIDENT_RESPONSE_FA.md)
- رفتار قوانین در تحلیل دقیقه‌ای (رپلیکای bucket-granularity در بستهٔ Python):
  [MACHINE_LEARNING_FA.md](MACHINE_LEARNING_FA.md)
