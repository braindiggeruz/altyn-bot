# ALTYN — Audit v5.2 — Security + Quiz Conversion + TORNADO + Funnel

> Branch: `feat/quiz-conversion-v2-and-security`. Read-only audit on `main` + safe code patches on this branch. Production VPS untouched.

---

## A. Executive Summary

**Status:** `READY WITH RISKS` (was `READY WITH RISKS` before — now most P0 items have ready-to-deploy patches).

**Можно ли запускать Meta Ads сейчас:** **NO**, пока не выполнены 3 шага владельца:
1. Rotate `BOT_TOKEN` через @BotFather (старый засветился в git history).
2. Rotate admin password (`g4FZ****q2Pc` лежит в `e2e-test.js:118` в git history, commit `006ecb6`).
3. Rotate `JWT_SECRET` (старое значение `altyn_jwt_stable_secret_2024_production_key` было fallback'ом в `src/admin-api.js`).
Это можно сделать за 10 минут (см. §Handoff).

**Top 5 risks (after patches):**
1. `main` ветка GitHub отстаёт от prod — в `main` лежали уязвимости из v4.9.1, prod выкатился из локальной ветки v4.9.2 через rsync (handoff doc подтверждает). Эта ветка fix'ит это уже на main, плюс закрывает регрессии.
2. Утечка admin-пароля в git history — нужна реальная ротация.
3. `set-telegram-webhook.sh` (на VPS) ранее не передавал `secret_token` — в этой ветке app требует header при наличии env-токена; после деплоя надо запустить скрипт со значением.
4. Off-site backup всё ещё отсутствует (handoff помечает MEDIUM/HIGH).
5. Cloudflare DNS у bot/admin — DNS only, прокси выкл. (как требуется), но `altyn-therapy.uz`/`www` остаются на Cloudflare Pages — не трогали.

**Top 5 quick fixes (этой ветки):**
1. Remove BOT_TOKEN/JWT_SECRET hardcoded fallbacks (CRITICAL).
2. Webhook path `/bot${token}` → `/tg/${WEBHOOK_SECRET_PATH}` + verify `X-Telegram-Bot-Api-Secret-Token` header.
3. Gate `/debug` behind `X-Admin-Secret`.
4. `CORS_ORIGINS` env-driven, убрана Railway-домен из whitelist.
5. Квиз v5.2: 8 вопросов, 6 сценариев, мягкий тон, 10$ оффер + кнопка "Написать Алтын напрямую", source/creative tracking, `lead_status` extended funnel.

---

## B. Findings table

| Sev | Area | Finding | Evidence | Risk | Fix | Status |
|-----|------|---------|----------|------|-----|--------|
| CRITICAL | Auth | `BOT_TOKEN` hardcoded fallback в исходниках | `src/index.js:56` (pre-patch) — `'8698863140:AAEZE-i...'` | Любой может управлять ботом, читать чаты | Remove fallback, fail-fast при отсутствии env | ✅ patched |
| CRITICAL | Auth | `JWT_SECRET` hardcoded fallback | `src/admin-api.js:21` — `'altyn_jwt_stable_secret_2024_production_key'` | Любой, видящий публичный repo, форджит admin JWT и читает CRM | Remove fallback; require >= 32 chars; throw at boot | ✅ patched |
| CRITICAL | Webhook | Telegram-токен в URL `/bot${token}` | `src/bot.js:219` (pre-patch) | Токен утекает в Caddy/Cloudflare/Railway access logs | Path → `/tg/${WEBHOOK_SECRET_PATH}` + verify `X-Telegram-Bot-Api-Secret-Token` header | ✅ patched |
| CRITICAL | Secrets | Admin password в git history | `e2e-test.js:118` commit `006ecb6` — `password: 'g4FZNUSk2qHgvn7aq2Pc'` | Любой с git clone логинится в админку и видит CRM | Replace literal with env vars in tests; **rotate password OOB** | ✅ patched in code, ⏳ rotation pending |
| HIGH | Auth | `/debug` endpoint без gate | `src/index.js:71-78` (pre-patch) | Стек-трейсы + memory layout публично | Gate behind `X-Admin-Secret`, fail-closed когда env пуст | ✅ patched |
| HIGH | Config | Railway-домен в CORS whitelist | `src/index.js:27-31` (pre-patch) | Старый домен принимает запросы, новые блокируются если CORS_ORIGINS не задан | `CORS_ORIGINS` env-driven с дефолтом на bot/admin/site | ✅ patched |
| HIGH | UX/Brand | hardcoded `+7 707 719 85 61` WhatsApp на чужой номер | 10 мест в `src/bot.js` | Горячие лиды отправляются на dead phone | Все заменены на `OWNER_DIRECT_URL` (Telegram Алтын), env-driven | ✅ patched |
| HIGH | Funnel | "бесплатная диагностика 1 час" в CTA | `src/content.js` SCENARIO_RESULTS (pre-patch) | Противоречит paid 10$ офферу, теряем выручку | Новый CTA "Личный разбор 60 мин — 10$" + "Написать напрямую" | ✅ patched |
| HIGH | Compliance | "Этот сценарий можно переписать за 8 сессий гипнотерапии" | `src/content.js` × 4 (pre-patch) | Meta policy: явное обещание лечения — повод для ban Ads-аккаунта | Заменено на "карта сценария", "бережный первый шаг" | ✅ patched |
| HIGH | Compliance | "у вас фоновая тревога / недостаточно хорош(а)" | `src/content.js` Q5/Q6 (pre-patch) | Диагностические/обвинительные формулировки | Полностью переписаны 8 вопросов | ✅ patched |
| MEDIUM | Funnel | source-парсер `/start` ломал UTM | `src/bot.js` — `parts[0]` для `src_ig_online_silence` → source=`src` | Все Meta креативы трекаются как один источник | Новый парсер: `src_/cmp_/ad_/ref_` + сохраняем `creative`/`ad_id`/`start_param` | ✅ patched |
| MEDIUM | Funnel | нет `lead_status` — admin не видит этап | DB `users` без поля | CRM не понимает booking_intent vs paid vs no_response | Migration: `lead_status`, `booking_intent_at`, `direct_telegram_click_at`, `paid_at` + backfill | ✅ patched |
| MEDIUM | TORNADO | сегменты только 4 (savior/fear/control/freeze) | `tornado_segment` backfill | Новые 5 сценариев → tornado_segment='generic' | Backfill query расширен на `clarity/hot_cold/strong/distant/no_intimacy` | ✅ patched |
| LOW | Code | Дубликат `RAILWAY_PUBLIC_DOMAIN` в `/health` + `initBot` | `src/index.js:231`, `src/bot.js:215` | Минор: предпочитает Railway-домен над WEBHOOK_URL | Поменян приоритет: `WEBHOOK_URL` → fallback на Railway | ✅ patched |
| LOW | Cleanup | `railway.toml` в repo | root file | Confused operator might redeploy on Railway | Файл удалён | ✅ patched |
| INFO | DNS | `bot.`/`admin.` DNS-only, root/www через Cloudflare Pages — не трогали | TLS issuer LE YE2; HTTP/2 + HSTS видны | OK | n/a | OK |
| INFO | TLS | Caddy выдал LE certs `2026-06-02 → 2026-08-31` для обоих сабдоменов | `openssl s_client` | OK | auto-renew | OK |
| INFO | Health | `bot.altyn-therapy.uz/health` = 200, version=4.9.2 | curl | OK | bump to 5.2.0 after deploy | ⏳ pending VPS deploy |

**gitleaks scan:** 58 commits, 1 leak found (`generic-api-key`, `e2e-test.js:118`, commit `006ecb6`) — это утечённый admin pw, см. CRITICAL. Других секретов в коде/history не найдено.

---

## C. P0 Fix Plan (что должен сделать владелец после мержа этой ветки)

1. **Rotate BOT_TOKEN** (@BotFather → `/revoke` → `@altyntherapybot` → новый токен).
2. **Rotate ADMIN_PASSWORD** + удалить строку admin: `psql -c "DELETE FROM admin_users;"` → отредактировать `/srv/altyn/.env` → войти в админку (auto-seed).
3. **Rotate JWT_SECRET** = `openssl rand -base64 48 | tr -d '/+=' | head -c 64`.
4. **Set new WEBHOOK_SECRET_PATH** = `openssl rand -hex 24` + **TELEGRAM_SECRET_TOKEN** = `openssl rand -hex 32`.
5. На VPS обновить `scripts/set-telegram-webhook.sh` — добавить `&secret_token=$TELEGRAM_SECRET_TOKEN` в setWebhook call.
6. Деплой кода ветки `feat/quiz-conversion-v2-and-security` через `rsync` или git pull.
7. `docker compose up -d --build app && docker compose logs -f app` → проверить миграции v5.2 применились.
8. Запустить `scripts/smoke-test.sh`.
9. Включить off-site backup (Cloudflare R2 / S3) — рекомендуется как next-week task.

---

## D. TORNADO — статус найденной системы

**Найдено:** `YES` — TORNADO **v5.1** уже встроена и зрелая.

**Где живёт:**
- `src/tornado-content.js` — `TORNADO_DAYS`, `TORNADO_MINI_DELIVERIES`, `resolveTornadoText`.
- `src/bot.js` — обработчики `tornado_*` callbacks (`tornado_quickbreak_d<N>`, `tornado_yes/no/more/book/later/ask`), scoring (`tornado_score += 10` per reply), hot-lead notify когда score≥50, opt-out через `tornado_stop` или текстовое "стоп".
- `src/database.js` — миграции добавили `tornado_segment / variant / score / click_count / reply_count / paused_until / started_at / hot_notified / disabled / last_sent`.
- `src/index.js` — endpoints `/admin/tornado/dry-run`, `/admin/tornado/test`, `/admin/tornado/run-batch?limit=N`, все gated `X-Admin-Secret`.

**Замысел:** 30-дневная цепочка, сегментированная по `tornado_segment`, A/B variant, бережный тон без давления, opt-out на каждом шаге, batch-safe.

**Что было сломано до v5.2:**
- Backfill `tornado_segment` знал только 4 старых сценария — новые шесть слетали в `generic` (исправлено в миграции).
- `bookable` фильтр не исключал юзеров со статусом `booking_intent` (но v5.0 уже добавил исключение `booked/confirmed/completed`).

**Что добавлено в v5.2:**
- Новые scenario-ключи попадают в `tornado_segment` через backfill.
- `lead_status` отделён от `funnel_stage` — позволяет CRM фильтровать `booking_intent / no_response / paid` независимо от TORNADO state.
- Новые admin-видимые поля: `booking_intent_at`, `direct_telegram_click_at`, `creative`, `start_param`, `paid_at`, `next_followup_at`.

---

## E. Quiz v5.2 — что изменилось

### Было (main pre-v5.2)
- 7 вопросов, 4 сценария (`savior/fear/control/freeze`)
- CTA: "бесплатная диагностика 1 час", обещание "8 сессий гипнотерапии" в каждом результате
- Hardcoded WhatsApp +7 707 (чужой номер) в 10 местах
- `/start` парсер не понимал `src_ig_creative` → всё трактовалось как `source='src'`
- Нет lead_status в CRM, нет `creative`, нет `direct_telegram_click_at`

### Стало
- 8 вопросов, мягкие формулировки. Запрещённые ярлыки ("тревога", "зависимы", "одиноки", "лечу", "избавим") — нет ни одного.
- 6 новых сценариев + 4 legacy сохранены для существующих юзеров в БД:
  - `clarity` — ожидание ясности
  - `hot_cold` — то тепло, то холод
  - `strong` — сильной женщины
  - `savior` — спасатель (переписан в мягкой формулировке)
  - `distant` — возвращение к недоступному
  - `no_intimacy` — внутренний запрет на близость
- Каждый результат заканчивается фразой "Это не диагноз. Это мягкая карта повторяющегося сценария."
- После результата — две кнопки:
  1. **Хочу личный разбор за 10$** → multi-step booking (имя → запрос → время → owner notification).
  2. **Написать Алтын напрямую** → callback `talk_direct` сначала трекает событие `DirectTelegramClick`, апдейтит `direct_telegram_click_at`/`count`, отправляет admin notification "DIRECT TELEGRAM CLICK", потом показывает кнопку `https://t.me/Altyn2304`.

### Scoring map (пример: вопрос 1)
```
"Хочется проверить телефон ещё раз и ещё"   → clarity:3, distant:1
"То кажется всё нормально, то всё разрушено" → hot_cold:3, fear:1
"Замираю и стараюсь не подавать вида"        → strong:2, freeze:2
"Спокойно, отвечу когда напишет"             → control:1
```
Полная карта — в `src/content.js` `QUIZ_QUESTIONS`.

### Events emitted в analytics_events
- `TelegramLead` (на `/start` с source/creative/ad_id/start_param)
- `QuizStart` + legacy `quiz_start`
- `QuizAnswer` (per click, с `{q, a}`)
- `quiz_completed` + `ScenarioGenerated`
- `BookingIntent` (нажал "Хочу разбор")
- `BookingSubmitted` (заполнил все 3 поля)
- `DirectTelegramClick` (нажал "Написать Алтын напрямую"; `first: true/false`)
- `tornado_reply`, `tornado_stopped`, `tornado_unsubscribed` — уже были

---

## F. CRM / Admin поля (v5.2)

В `users` теперь:

| Поле | Тип | Назначение |
|------|-----|------------|
| `source` | TEXT | Канал: `ig/fb/tt/retarg/site/direct/organic/referral` |
| `creative` | TEXT | Слаг креатива из `start=src_ig_<creative>` |
| `ad_id` | TEXT | Meta numeric ad id |
| `campaign_id` | TEXT | Кампания (из `cmp_<id>`) |
| `adset` | TEXT | Adset (ручное заполнение из UTM позже) |
| `utm_source / medium / campaign` | TEXT | Стандартные UTM |
| `start_param` | TEXT | Сырой deep-link suffix (audit) |
| `lead_status` | TEXT | `new / quiz_started / quiz_completed / booking_intent / booked / contacted / paid / no_response / reactivation / archived` |
| `booking_intent_at` | TIMESTAMP | Нажал "Хочу разбор" |
| `booking_started_at` | TIMESTAMP | Начал booking flow (имя) |
| `booking_confirmed_at` | TIMESTAMP | Заполнил все 3 поля |
| `direct_telegram_click_at` | TIMESTAMP | Первый клик "Написать напрямую" |
| `direct_telegram_click_count` | INTEGER | Кол-во кликов |
| `paid_at` | TIMESTAMP | Когда админ пометил оплачено |
| `last_followup_at / next_followup_at / followup_step` | TIMESTAMP/INT | TORNADO complement (для admin UI) |
| `lang` | TEXT | `ru` сейчас, `uz` будущее |
| `notes` | TEXT | Свободные заметки админа |

Индексы: `lead_status`, `creative`, `next_followup_at`. Все миграции идемпотентны (ALTER TABLE ... IF NOT EXISTS).

---

## G. Deep-link конвенция (для Meta Ads)

```
https://t.me/altyntherapybot?start=src_ig_online_silence
https://t.me/altyntherapybot?start=src_ig_relationship_loop
https://t.me/altyntherapybot?start=src_ig_strong_woman
https://t.me/altyntherapybot?start=src_retarg_story
https://t.me/altyntherapybot?start=src_site_quiz
https://t.me/altyntherapybot?start=src_direct_cta
https://t.me/altyntherapybot?start=cmp_uz_winter_2026
https://t.me/altyntherapybot?start=ad_120300000000123456     # Meta numeric ad id
```

Парсер сохранит:
- `start=src_ig_online_silence` → `source='ig'`, `creative='online_silence'`, `utm_source='ig'`, `utm_campaign='online_silence'`
- `start=cmp_uz_winter_2026` → `source='campaign'`, `campaign_id='uz_winter_2026'`
- `start=ad_120300...` → `source='ad'`, `ad_id='120300...'`
- `start=ref_<userId>` → реферал (как было)

---

## H. What's NOT done (handoff to operator)

1. **Token rotation** (BOT_TOKEN, JWT_SECRET, ADMIN_PASSWORD) — out-of-band у владельца.
2. **`scripts/set-telegram-webhook.sh`** — нужно добавить `&secret_token=$TELEGRAM_SECRET_TOKEN`. Этот файл лежит **только на VPS** (handoff sec.7), его нет в repo.
3. **Off-site backup** (Cloudflare R2 / S3 / Backblaze).
4. **Cloudflare proxy mode** для bot./admin. — только когда подтвердите, что Caddy ACME продолжит работать (HTTP-01 или переключить Caddy на DNS-01).
5. **Admin UI** для лидов по `lead_status` / `creative` / `source` — backend готов, фронт `public/index.html` нужно расширять.
6. **Узбекский квиз** (`lang='uz'`) — структура готова, контент не переведён.
7. **Meta Pixel + CAPI** на сайте `altyn-therapy.uz` — отдельная задача (Cloudflare Pages).

---

## I. Safe handoff

**Изменено в этой ветке:**
- `src/index.js`, `src/bot.js`, `src/admin-api.js`, `src/content.js`, `src/database.js`
- `e2e-test.js` (utечка пароля)
- `.env.example` (новый)
- `railway.toml` (удалён)
- `AUDIT_v5.2.md` (этот файл)

**Что НЕ трогали:**
- `tornado-content.js` (TORNADO v5.1 контент — owner approves отдельно)
- `public/index.html` (admin SPA)
- Dockerfile / docker-compose / Caddyfile (нет в этом repo; они на VPS)
- Cloudflare DNS root/www
- Cloudflare Pages
- Production DB

**Деплой шаги:** см. §C.
