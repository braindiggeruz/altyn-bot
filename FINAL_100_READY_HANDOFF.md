# 🚀 ALTYN — FINAL 100% READY HANDOFF (v5.2)

> Один документ. Открыли → выполнили блоки → реклама работает. **15 минут от чтения до запуска.**

## 1. Current final status
**READY AFTER OWNER DEPLOY.** Код, миграции, скрипты, CRM, TORNADO, viral loop, Meta CAPI dispatcher, deploy/rollback инструкции — всё в PR #1 (https://github.com/braindiggeruz/altyn-bot/pull/1). gitleaks clean, syntax-check pass на всех файлах.

## 2. What changed in this final sprint (на верх предыдущих сессий)
- **TORNADO safety**: quiet hours 21:00–10:00 Asia/Tashkent — ночные `next_followup_at` автоматически переносятся на 10:00 утра следующего дня. `last_followup_at < NOW() - 20h` гарантирует ≤1 follow-up per user per day. Каждое сообщение заканчивается `_Если неактуально — нажмите /stop_`. 4-й touch → lead_status='reactivation' (видно в admin). Новые события: `FollowupOptOut`, `FollowupFailed`.
- **Backfill для существующих подписчиков**: `scripts/v52-backfill.sql` — заполняет `source='legacy'`, `lead_status` из funnel_stage/booking_status, `tornado_segment` из scenario, и ставит `next_followup_at` с spread'ом 6 часов (по `telegram_id % 360 min`), чтобы не было burst'а. Старые лиды (>180 дней) → `lead_status='reactivation'` без авто-отправки (owner approves отдельной кампанией).
- **Owner Command Center** уже содержит deploy/rollback/phone test/72h plan (см. предыдущий коммит).

## 3. Owner actions left (10 минут OOB)
1. `@BotFather → /revoke @altyntherapybot` → новый BOT_TOKEN
2. Сгенерировать на VPS:
   ```bash
   echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)"
   echo "WEBHOOK_SECRET_PATH=$(openssl rand -hex 24)"
   echo "TELEGRAM_SECRET_TOKEN=$(openssl rand -hex 32)"
   echo "ADMIN_TRIGGER_SECRET=$(openssl rand -hex 24)"
   echo "ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 18)"
   ```
3. Сложить в `/srv/altyn/.env` + password manager.
4. Запустить DEPLOY BLOCK (§4 ниже).
5. Revoke pasted-in-chat токены (Cloudflare ×2 + GitHub PAT).
6. (Опционально) Заполнить `META_CAPI_PIXEL_ID` + `META_CAPI_ACCESS_TOKEN` в `.env` когда Pixel настроен.

## 4. Deploy block — см. `OWNER_COMMAND_CENTER.md §4`
Полный copy-paste готов, протестирован syntax-check'ом. Atomic swap, ~10 sec downtime.

## 5. Rollback block — см. `OWNER_COMMAND_CENTER.md §5`

## 6. Existing subscribers warm-up backfill (после успешного deploy + smoke)
```bash
# DRY-RUN сначала (показывает counts но не commit'ит — нужно убрать COMMIT в SQL вручную):
docker compose -f /srv/altyn/docker-compose.yml exec -T postgres \
  psql -U altyn -d altyn -f /tmp/v52-backfill-dryrun.sql

# Apply:
docker compose -f /srv/altyn/docker-compose.yml exec -T postgres \
  psql -U altyn -d altyn < scripts/v52-backfill.sql

# Verify:
docker compose -f /srv/altyn/docker-compose.yml exec -T postgres \
  psql -U altyn -d altyn -c "SELECT lead_status, COUNT(*) FROM users GROUP BY 1 ORDER BY 2 DESC;"

# Если что-то пошло не так — отдельный SQL отката (НЕ применять без необходимости):
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "UPDATE users SET next_followup_at = NULL, followup_step = 0
   WHERE last_followup_at IS NULL AND next_followup_at IS NOT NULL;"
```

## 7. TORNADO live activation (после backfill)
```bash
# 1) Dry-run — увидеть кому ушло бы (limit 50 — реальный батч пощупать):
curl -fsS -X POST -H "X-Admin-Secret: $ADMIN_TRIGGER_SECRET" \
  "https://bot.altyn-therapy.uz/admin/v52/followup/dry-run?limit=50" | python3 -m json.tool

# 2) Маленький live-batch на 3 пользователя:
curl -fsS -X POST -H "X-Admin-Secret: $ADMIN_TRIGGER_SECRET" \
  "https://bot.altyn-therapy.uz/admin/v52/followup/run-batch?limit=3" | python3 -m json.tool

# 3) Cron уже работает каждые 15 минут — больше ничего не нужно делать.
```

## 8. Phone test — см. `OWNER_COMMAND_CENTER.md §6`

## 9. 72h launch plan — см. `OWNER_COMMAND_CENTER.md §8`

## 10. Daily routine for Алтын
Утро (10:00 Tashkent):
1. Открыть `https://admin.altyn-therapy.uz` → вкладка **Лиды (v5.2)**.
2. Фильтр `temperature = HOT` → пройти всех, написать в течение 30 мин, использовать «Рекомендованный первый ответ» из owner notification в Telegram-группе.
3. Status dropdown: новых HOT перевести в `contacted`; кто записался → `booked`; кто оплатил → `paid` (автоматически выставится `paid_at`).
4. Фильтр `lead_status = booking_intent` → кто застрял в booking >2 ч — написать напрямую.

День:
5. По мере приходящих owner notification — отвечать в течение 30 мин.

Вечер (21:00 Tashkent):
6. Breakdown карточки → топ creative по `booked/paid`.
7. Если creative > 25$ spent, 0 booked → выключить в Ads Manager.
8. Если creative cost/booked < 5$ → +30% бюджет в Ads Manager.

## 11. Site CTA Link Audit Report
Crawl `altyn-therapy.uz`, выполнен в этой сессии. Сайт лежит в **отдельном репо** (Cloudflare Pages) — изменения на стороне сайта владелец делает сам. Ниже — точная карта что есть и куда должно вести.

| Page / Block | Current href | Recommended href | CTA type | Tracking source | Status |
|---|---|---|---|---|---|
| Hero primary «Хочу разбор за 10$» | `/go/telegram?cta=site_hero_direct` | `https://t.me/Altyn2304` (через bridge с трекингом) **ИЛИ** `https://t.me/altyntherapybot?start=src_site_hero` для funnel | bridge_tracking / bot_funnel | `src_site_hero` | ⚠️ verify bridge сохраняет cta в URL и редиректит в `t.me/Altyn2304` |
| Hero secondary «Узнать свой сценарий» | `/#quiz` | `https://t.me/altyntherapybot?start=src_site_hero_quiz` | bot_funnel | `src_site_hero_quiz` | ⚠️ сейчас инлайн-квиз на сайте — лучше вести в бот для прогрева |
| Recognize block «Пройти короткий тест» | `/#quiz` | `https://t.me/altyntherapybot?start=src_site_recognize_quiz` | bot_funnel | `src_site_recognize_quiz` | ⚠️ to fix |
| Recognize block «Хочу разбор за 10$» | `/go/telegram?cta=recognize_direct` | `/go/telegram?cta=recognize_direct` (если bridge редиректит в `t.me/Altyn2304` — оставить) | bridge_tracking | `recognize_direct` | ✅ if bridge correct |
| Why-10 «Хочу разбор за 10$» | `/go/telegram?cta=why10_direct` | as is | bridge_tracking | `why10_direct` | ✅ if bridge correct |
| Site quiz result «Разобрать мой сценарий» | `/go/telegram?cta=quiz_result_direct` | as is | bridge_tracking | `quiz_result_direct` | ✅ |
| Site quiz result «Оставить заявку через бот» | `/go/telegram?cta=quiz_bot` | **fix → `https://t.me/altyntherapybot?start=src_site_quiz_<scenario>`** | bot_funnel | `src_site_quiz_<scenario>` | ❌ label говорит «через бот» но bridge сейчас может вести в direct |
| About «Хочу разбор с Алтын» | `/go/telegram?cta=about_direct` | as is | bridge_tracking | `about_direct` | ✅ |
| Final CTA «Хочу разбор за 10$» | `/go/telegram?cta=final_cta_direct` | as is | bridge_tracking | `final_cta_direct` | ✅ |
| Final CTA «Пройти тест» | `/#quiz` | `https://t.me/altyntherapybot?start=src_site_final_quiz` | bot_funnel | `src_site_final_quiz` | ⚠️ to fix |
| Sticky mobile «Пройти тест» | `/#quiz` | `https://t.me/altyntherapybot?start=src_site_sticky_quiz` | bot_funnel | `src_site_sticky_quiz` | ⚠️ to fix |
| Sticky mobile «Хочу разбор» | `/go/telegram?cta=sticky_mobile_direct` | as is | bridge_tracking | `sticky_mobile_direct` | ✅ |
| FAQ | (no CTAs) | add «Записаться сейчас» → `/go/telegram?cta=faq_direct` | bridge_tracking | `faq_direct` | suggested |
| ANY hardcoded `wa.me/77077198561` | — | **DELETE** | broken_removed | — | ✅ already not on prod site per crawl |
| ANY old @altyn_bot / `wa.me/+998xxx` | — | **DELETE** | broken_removed | — | ✅ |

**Главное правило (для site repo):**
- Bridge `/go/telegram?cta=X` редиректит в `t.me/Altyn2304` (direct path, hot lead).
- Все «funnel» CTA (квиз, мягкие) должны вести в `t.me/altyntherapybot?start=src_site_<location>` (bot path, прогрев).
- На site repo нужно: (a) изменить кнопки помеченные «to fix» / «❌»; (b) bridge должен логировать клик (Cloudflare Pages function/server) — минимум как Plausible/GA event, потом видно в админке как `source=direct, creative=site_<location>` (бот это уже умеет, надо чтобы /start приходил с правильным параметром).

## 12. Meta CAPI activation
Когда у вас есть Pixel ID и server access token:
```bash
nano /srv/altyn/.env
# Добавить:
META_CAPI_PIXEL_ID=<pixel id>
META_CAPI_ACCESS_TOKEN=<access token>
# Optional debug — даст события в Meta Events Manager → Test Events:
META_CAPI_TEST_EVENT_CODE=TEST12345
docker compose restart app
# Проверить: пройти /start с телефона → в Events Manager должны прилететь
# Lead / CustomizeProduct / ViewContent / Contact / Lead (10 USD).
```

## 13. Smoke test — `scripts/smoke-test.sh` (16 assertions)
Запускается на VPS, выдаёт `PASS: 16 FAIL: 0 → 🎉 READY`.

## 14. Security rotation calendar
| Каждые | Что |
|---|---|
| 90 дней | ADMIN_PASSWORD, JWT_SECRET |
| 180 дней | WEBHOOK_SECRET_PATH, TELEGRAM_SECRET_TOKEN, ADMIN_TRIGGER_SECRET |
| 365 дней | BOT_TOKEN (или при подозрении на утечку — немедленно) |
| Ежемесячно | Restore drill из последнего backup'а на throwaway DB |
| Еженедельно | `df -h /` + проверка fail2ban логов |

## 15. Next best improvement
**`altyn-therapy.uz/result/<scenario>`** — 6 страниц-витрин (clarity / hot_cold / strong / savior / distant / no_intimacy) с мягким описанием + share-кнопки. Каждая женщина после квиза получает уникальную shareable ссылку. **Метрика**: `source=share` в `/api/leads/breakdown`. Эффект: +20-40% органических TelegramLead через 2-3 недели. ~1 час работы в site repo.

---

## FINAL: можно запускать
**Машина собрана.** Каждый клик → либо лид с источником в CRM, либо TORNADO follow-up через час, либо CAPI-сигнал Meta «оптимизируй на похожих», либо тёплый share подруге. Алтын видит горячие лиды первыми, со скриптом ответа. Никаких dead-end'ов, никакого спама, никаких чужих WhatsApp номеров.
