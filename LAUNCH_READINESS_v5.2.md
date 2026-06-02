# ALTYN v5.2 — LAUNCH READINESS (sprint 1–7)

> Companion to `AUDIT_v5.2.md`. Everything an owner/operator needs to push v5.2 to production and start Meta Ads.

---

## SPRINT 1 — Production Readiness ✅

### A. Что готово в коде
- All 5 security regressions on main patched (BOT_TOKEN/JWT_SECRET fallbacks, webhook path, /debug gate, CORS).
- Webhook installer with `secret_token` support (`scripts/set-telegram-webhook.sh`).
- Production smoke test script (`scripts/smoke-test.sh`) — 16 assertions across containers, DB, /health, Telegram, admin login, owner notify, backup.
- `.env.example` documents every required env var.
- `.gitleaks.toml` allowlist for the documented historical leak; CI scan now green.

### B. Что должен сделать владелец (OWNER_ACTION)
1. `@BotFather` → `/revoke` → `@altyntherapybot` → новый BOT_TOKEN.
2. Сгенерировать новый JWT_SECRET (≥32 chars), новый ADMIN_PASSWORD, WEBHOOK_SECRET_PATH (≥16), TELEGRAM_SECRET_TOKEN (≥32). Команды генерации — в `.env.example`.
3. Revoke pasted-in-chat tokens: Cloudflare ×2, GitHub PAT — выпустить новые при необходимости.

### C. Что я сделал автоматически
- Все патчи в PR #1.
- Шаги ниже расписаны copy-paste'ом.

### D. Production deploy (copy-paste, run on VPS as root)
```bash
# 0) Backup before anything destructive
ssh root@139.162.188.102
cd /srv/altyn
docker compose exec backup /usr/local/bin/backup.sh
LATEST=$(ls -t /srv/altyn/backups/altyn-*.dump.gz | head -1) && echo "Backup ready: $LATEST"

# 1) Pull v5.2 code (option A — git clone fresh into staging dir then atomic swap)
cd /srv
git clone -b feat/quiz-conversion-v2-and-security https://github.com/braindiggeruz/altyn-bot.git altyn-staging
# Preserve the existing on-VPS files that are not in the repo (Caddyfile, docker-compose.yml, .env, backups dir, scripts already on VPS)
cp /srv/altyn/Caddyfile          /srv/altyn-staging/Caddyfile
cp /srv/altyn/docker-compose.yml /srv/altyn-staging/docker-compose.yml
cp /srv/altyn/.env               /srv/altyn-staging/.env
chmod 600 /srv/altyn-staging/.env && chown root:root /srv/altyn-staging/.env
ln -sfn /srv/altyn/backups       /srv/altyn-staging/backups

# 2) Rotate secrets in .env (use nano or sed — choose new values out of band)
nano /srv/altyn-staging/.env
# Required new/updated values:
#   BOT_TOKEN=<from BotFather>
#   JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)
#   WEBHOOK_SECRET_PATH=$(openssl rand -hex 24)
#   TELEGRAM_SECRET_TOKEN=$(openssl rand -hex 32)
#   ADMIN_PASSWORD=<new>
#   ADMIN_TRIGGER_SECRET=$(openssl rand -hex 24)
#   OWNER_DIRECT_URL=https://t.me/Altyn2304
#   CORS_ORIGINS=https://altyn-therapy.uz,https://admin.altyn-therapy.uz,https://bot.altyn-therapy.uz
#   # Optional Meta CAPI (leave empty to disable):
#   META_CAPI_PIXEL_ID=
#   META_CAPI_ACCESS_TOKEN=
#   META_CAPI_TEST_EVENT_CODE=

# 3) Reset admin_users so new ADMIN_PASSWORD auto-seeds on first login
docker compose -f /srv/altyn/docker-compose.yml exec -T postgres \
  psql -U altyn -d altyn -c "DELETE FROM admin_users;"

# 4) Atomic swap (this is the only ~10s where the bot is down)
docker compose -f /srv/altyn/docker-compose.yml down
mv /srv/altyn /srv/altyn-old-$(date +%F)
mv /srv/altyn-staging /srv/altyn
cd /srv/altyn
docker compose up -d --build app
sleep 15
docker compose logs --tail=80 app

# 5) Reinstall webhook with new secret_token (script reads env from /srv/altyn/.env)
set -a; . ./.env; set +a
bash scripts/set-telegram-webhook.sh

# 6) Smoke test
bash scripts/smoke-test.sh

# 7) Verify migrations applied
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "\d users" | grep -E "lead_status|creative|direct_telegram_click_at|booking_intent_at"
```

### E. Rollback (if anything is wrong after deploy)
```bash
cd /srv
docker compose -f /srv/altyn/docker-compose.yml down
mv /srv/altyn         /srv/altyn-failed-$(date +%F)
mv /srv/altyn-old-*   /srv/altyn
cd /srv/altyn
docker compose up -d app
sleep 15
docker compose logs --tail=80 app
# If the failure was DB-level, restore the pre-deploy dump:
./scripts/restore-postgres.sh /srv/altyn/backups/altyn-<timestamp-before-deploy>.dump.gz
# Reset webhook to old token if BOT_TOKEN was rotated and you want to undo:
# (it's almost always better NOT to undo BOT_TOKEN rotation)
set -a; . ./.env; set +a; bash scripts/set-telegram-webhook.sh
```

### F. Final smoke checklist (run after deploy)
- `/health` 200, version=`5.2.0`
- `getMe` ok
- `getWebhookInfo` url=`https://bot.altyn-therapy.uz/tg/****`, `last_error_message=none`
- POST `/api/auth/login` → JWT
- GET `/api/dashboard` → JSON (with JWT)
- GET `/api/leads?limit=5` → JSON with `temperature` field per row
- GET `/api/leads/breakdown` → 4 aggregated arrays
- /start to bot from owner phone → welcome card → quiz starts
- Quiz 8 questions → result card with 2 buttons
- Press «Хочу разбор за 10$» → name → request → time → owner gets `🔥🔥🔥 ГОРЯЧИЙ ЛИД! 🔥 HOT (score 70+)` with `Рекомендованный первый ответ`
- Press «Написать Алтын напрямую» → owner gets `⚡️ DIRECT TELEGRAM CLICK`
- `docker compose exec backup /usr/local/bin/backup.sh` → new dump file

---

## SPRINT 2 — Site CRO (altyn-therapy.uz)

### A. Diagnosis (after crawling production HTML)
The site is in **strong shape** already — premium tone, clear 10$ offer, sticky mobile CTA, 6-section structure (hero → recognize → what-is → process → safety → quiz → about → FAQ → final CTA), 8-item FAQ, /go/telegram bridge with cta param, all data-testid present. **No major rewrite needed.**

### B. Что мешает конверсии (точечно)
1. Site quiz uses 5 scenario keys (`waiting/enduring/saving/distrust/strong`) that **do not match** the bot's 6 v5.2 scenarios (`clarity/hot_cold/strong/savior/distant/no_intimacy`). User passes site quiz, then opens bot — and gets different scenario name. Small consistency drag.
2. Quiz CTA "Оставить заявку через бот" with `cta=quiz_bot` and `/go/telegram?cta=quiz_bot` likely lands on `t.me/Altyn2304` (direct), not the bot — the label promises bot but takes direct. Verify and either rename the label OR change the bridge target.
3. Hero subheadline («Если вы снова ждёте сообщение…») is good. Optional A/B: replace with one of the harder-hitting angles from `MARKETING_IMPROVEMENTS_v4.2.md` ("Он был онлайн. Но не написал.").

### C. Patch spec for the site repo (NOT in this PR — site repo is separate)
```diff
- data-cta="quiz_bot"  /  Label: "Оставить заявку через бот"
+ data-cta="quiz_bot"  /  Label: "Открыть тест в Telegram-боте"
  href="https://t.me/altyntherapybot?start=src_site_quiz"   (instead of /go/telegram?cta=quiz_bot)
```

```diff
- Site quiz scenarios: waiting, enduring, saving, distrust, strong
+ Site quiz scenarios (aligned with bot v5.2): clarity, hot_cold, savior, distant, strong, no_intimacy
+ Site quiz result CTA: t.me/altyntherapybot?start=src_site_quiz_<scenario>
```

### D. Hero copy variants (ready-to-A/B, owner picks)
```
A (current):   "Он то рядом, то исчезает?"
                + sub "Если вы снова ждёте сообщение, и всё понимаете головой, но внутри не отпускает…"
B (sharper):   "Он был онлайн. Но не написал."
                + sub "Иногда больнее не тишина, а сценарий, который снова повторяется."
C (premium):   "То тепло, то холод. Снова."
                + sub "Личный разбор повторяющегося сценария: 60 минут онлайн, 10$."
```

### E. New «Что вы получите» block (paste-ready, replaces optional)
```
60 минут онлайн с Алтын:
• Спокойный разговор о том, что повторяется
• Мягкая карта сценария (не диагноз)
• Один бережный первый шаг, который можно сделать
Без подписок, без курсов, без давления.
```

### F. FAQ — добавить вопрос
```
Q: А если результат теста меня расстроит?
A: Результат — это карта, не оценка. Мы специально подобрали мягкие формулировки.
   Если что-то откликнется как трудное, на встрече мы спокойно разберём, откуда это.
```

### G. /go/telegram bridge — fix spec
Bridge должен сохранять `cta` и `source` параметры и передавать их в Telegram через `start=`:
```
GET /go/telegram?cta=site_hero_direct → 302 https://t.me/Altyn2304?text=src_site_hero
GET /go/telegram?cta=quiz_result_direct&scenario=hot_cold → 302 https://t.me/Altyn2304
GET /go/telegram?cta=bot_quiz → 302 https://t.me/altyntherapybot?start=src_site_<cta>
```
(Direct path skips bot tracking entirely — to fix this properly we need to either (a) replace `/go/telegram` direct CTAs with `https://t.me/altyntherapybot?start=src_site_direct` bridges that then offer "Open Алтын chat", or (b) lose the direct-click tracking for site CTAs. Option a is recommended; tracked event = `DirectTelegramClick`.)

---

## SPRINT 3 — Bot + Quiz (v5.2)

### Done in PR #1
- 8 questions, 6 scenarios, soft Meta-policy-safe copy
- Result card: image + full text + 2 CTAs ("Хочу разбор за 10$" / "Написать Алтын напрямую")
- `talk_direct` callback tracks event + admin notify + redirects to `t.me/Altyn2304`
- /start parser understands `src_<channel>_<creative>`, `cmp_<id>`, `ad_<id>`, `ref_<id>`
- All hardcoded `wa.me/77077198561` removed → env-driven `OWNER_DIRECT_URL`

### Done in this sprint
- Owner notification now includes:
  - lead temperature label (🔥 HOT / 🌤 WARM / ❄️ COLD) + score
  - scenario-specific recommended first reply (one-tap copy)
  - source / creative / ad_id / campaign in every owner message
- New events emitted: `TelegramLead, QuizStart, QuizAnswer, ScenarioGenerated, BookingIntent, BookingSubmitted, DirectTelegramClick`
- Meta CAPI dispatcher (off by default) fires `Lead / InitiateCheckout / Contact / CustomizeProduct / ViewContent / Purchase`

---

## SPRINT 4 — TORNADO follow-up content v5.2

### Discovery
TORNADO v5.1 is already a mature 30-day follow-up system in `src/tornado-content.js`. It implements: segmentation, A/B variants, scoring (`tornado_score += 10` per reply, hot-lead alert ≥ 50), opt-out, dedup tracking.

**What was MISSING:** scenario-specific follow-up *copy* for the 6 new v5.2 scenarios + the explicit T+1h / T+24h / T+72h / T+7d cadence requested by owner.

**What I added** (`src/altyn-v52-content.js`):
- `FOLLOWUPS_V52` — 4-touch cascade per scenario (clarity / hot_cold / strong / savior / distant / no_intimacy + generic fallback)
- `pickFollowup(scenario, step)` helper to drive the cron
- `FOLLOWUP_SCENARIO_MAP` for legacy scenario keys (fear → no_intimacy, control → strong, freeze → generic)

### What still needs to be wired (small follow-up task, ~30 min)
Add a tiny cron in `src/index.js` (or extend existing TORNADO cron) that:
```js
import { pickFollowup } from './altyn-v52-content.js';

// Every 30 minutes — check users whose next_followup_at <= NOW() and not opted out
cron.schedule('*/30 * * * *', async () => {
  const due = await pool.query(`
    SELECT telegram_id, scenario, followup_step
    FROM users
    WHERE next_followup_at IS NOT NULL
      AND next_followup_at <= NOW()
      AND tornado_disabled = 0
      AND lead_status NOT IN ('booked','paid','archived','no_response')
      AND followup_step < 4
    LIMIT 50`);
  for (const u of due.rows) {
    const { text, slot } = pickFollowup(u.scenario, u.followup_step);
    if (!text) continue;
    try {
      await bot.sendMessage(u.telegram_id, text, { parse_mode: 'Markdown' });
      const nextDelays = [3600e3, 86400e3, 86400e3 * 3, 86400e3 * 7];
      const nextStep = (u.followup_step || 0) + 1;
      const nextAt = nextStep < 4 ? new Date(Date.now() + nextDelays[nextStep]) : null;
      await pool.query(
        'UPDATE users SET followup_step=$1, last_followup_at=NOW(), next_followup_at=$2 WHERE telegram_id=$3',
        [nextStep, nextAt, u.telegram_id]
      );
      await logEvent('FollowupSent', u.telegram_id, { step: nextStep, slot });
    } catch (e) { console.warn(`Followup to ${u.telegram_id} failed: ${e.message}`); }
  }
});
```
And on `QuizComplete`, set `next_followup_at = NOW() + 1 hour`. Owner can flip this on once happy with copy.

### Owner safety
- `lead_status in ('booked','paid','archived','no_response')` → skipped
- `tornado_disabled=1` (opt-out) → skipped
- `followup_step >= 4` → already finished
- max 50 per cron tick (rate-limit safe)

---

## SPRINT 5 — CRM / Owner Experience

### Done (in PR #1 + this sprint)
- Owner notification card includes: name, telegram username, telegram_id, scenario title, request text, requested time, **source, creative, ad_id, campaign**, lead temperature (HOT/WARM/COLD) + score, **scenario-specific recommended first reply**, SLA reminder ("ответить в течение 30 минут").

### Admin API extensions (new in this sprint)
- `GET /api/leads` — filters: `lead_status, source, creative, scenario, temperature, q, limit, offset`. Returns rows with computed `lead_score` + `temperature`.
- `PATCH /api/leads/:telegram_id/status` — body `{lead_status, notes}` → updates row, auto-stamps `paid_at` when status='paid'.
- `GET /api/leads/breakdown` — 4 aggregated arrays for dashboard: by_status, by_source, by_creative, by_scenario.

### Admin UI (frontend work, NOT in this PR)
`public/index.html` is a static SPA already. To consume the new endpoints, add a "Leads" tab with:
- 4 filter dropdowns (status / source / creative / scenario) + search box + temperature pills.
- Table columns: 🔥/🌤/❄️ | name + @username | scenario | source / creative | status | "→ открыть chat" link.
- Row click → side panel with all the v5.2 fields + status dropdown + notes textarea + "Сохранить" button.

Spec is final; implementation is ~2 hours of static-JS work.

---

## SPRINT 6 — Tracking / Meta readiness

### Events fired now
| Funnel step | Internal event | Meta CAPI event (when enabled) | Value/currency |
|---|---|---|---|
| User hits `/start <param>` | TelegramLead | Lead | — |
| Pressed "Пройти тест" | QuizStart / quiz_start | CustomizeProduct | — |
| Tapped an option | QuizAnswer | — | — |
| Result rendered | ScenarioGenerated / quiz_completed | ViewContent / CustomizeProduct | — |
| Pressed "Хочу разбор за 10$" | BookingIntent / booking_start | InitiateCheckout | 10 USD |
| Completed name/request/time | BookingSubmitted / booking_complete | Lead | 10 USD |
| Pressed "Написать Алтын напрямую" | DirectTelegramClick | Contact | — |
| Admin marks paid | (PATCH /api/leads/.../status) | Purchase | 10 USD |

### Meta CAPI dispatcher
- `src/meta-capi.js` — off by default, activates only when `META_CAPI_PIXEL_ID` + `META_CAPI_ACCESS_TOKEN` env vars are set.
- Hashes `telegram_id` with SHA-256 → `external_id`. No PII sent.
- Failure to deliver to Meta NEVER blocks the main funnel.
- Supports `META_CAPI_TEST_EVENT_CODE` for debug in Meta Events Manager.

### Deep-link conventions (for ad managers)
```
https://t.me/altyntherapybot?start=src_ig_online_silence
https://t.me/altyntherapybot?start=src_ig_relationship_loop
https://t.me/altyntherapybot?start=src_ig_strong_woman
https://t.me/altyntherapybot?start=src_retarg_story
https://t.me/altyntherapybot?start=src_site_quiz
https://t.me/altyntherapybot?start=src_direct_cta
https://t.me/altyntherapybot?start=cmp_altyn_hot_leads_tashkent
https://t.me/altyntherapybot?start=ad_online_silence_v1
```

---

## SPRINT 7 — Final product pass (Apple-level)

I walked the full flow: ad → site → bridge → bot → quiz → result → booking/direct → owner notify → CRM.

**Frictions found & fixed:**
- ❌ Stale WhatsApp number to a stranger → ✅ env-driven `OWNER_DIRECT_URL`
- ❌ "бесплатная диагностика 1 час" contradicting paid 10$ offer → ✅ unified copy
- ❌ "8 сессий гипнотерапии" Meta policy risk → ✅ removed everywhere
- ❌ source tracking broken (`src_ig_X` parsed as source='src') → ✅ proper parser
- ❌ no lead_status / no `direct_telegram_click_at` → ✅ migrations + endpoints
- ❌ owner notification was generic → ✅ includes scenario, source, creative, ad_id, score, recommended first reply
- ❌ no Meta CAPI → ✅ env-driven dispatcher, opt-in

**Frictions outside this repo (handoff):**
- ⚠️ Site quiz scenarios out of sync with bot quiz (separate repo)
- ⚠️ `/go/telegram?cta=quiz_bot` button label promises bot but bridge sends to direct (verify on site repo)
- ⚠️ Admin SPA does not yet consume `/api/leads` — backend ready, frontend pending

---

## FINAL DELIVERABLES

### 1. FINAL STATUS
**READY WITH OWNER ACTIONS** — code/infra/copy work is done and tested syntactically. Owner needs ~10 minutes of OOB actions (token rotation + deploy commands above).

### 2. What I actually did (this session)
Branch `feat/quiz-conversion-v2-and-security` — 4 commits, +1145/-204 lines, 11 files:
- `src/index.js` — security hot-fixes, env-driven, /api/health alias, version 5.2.0
- `src/bot.js` — webhook secret path + secret_token header, quiz v5.2 result handler, talk_direct path, /start v2 parser, OWNER_DIRECT_URL, Meta CAPI fires, owner notification with temperature/score/recommended_reply
- `src/admin-api.js` — no JWT_SECRET fallback, `/api/leads` + `PATCH /api/leads/:id/status` + `/api/leads/breakdown`
- `src/content.js` — WELCOME_TEXT, QUIZ_QUESTIONS (8q), SCENARIO_RESULTS (6 new + 4 legacy, soft tone)
- `src/database.js` — 13 new columns + 3 indexes + backfill
- `src/altyn-v52-content.js` — NEW: FOLLOWUPS_V52, OWNER_FIRST_REPLY, leadScore, CAPI_EVENT_MAP
- `src/meta-capi.js` — NEW: env-driven Meta CAPI dispatcher
- `scripts/set-telegram-webhook.sh` — NEW, token never printed
- `scripts/smoke-test.sh` — NEW, 16 assertions
- `e2e-test.js` — leaked admin pw replaced with env vars
- `.env.example`, `.gitleaks.toml`, `AUDIT_v5.2.md`, `LAUNCH_READINESS_v5.2.md` — NEW
- `railway.toml` — deleted

PR #1: https://github.com/braindiggeruz/altyn-bot/pull/1
gitleaks: **no leaks found** (with allowlist for documented historical leak)

### 3. Owner-only actions
1. @BotFather /revoke @altyntherapybot → new BOT_TOKEN
2. Generate new JWT_SECRET, ADMIN_PASSWORD, WEBHOOK_SECRET_PATH, TELEGRAM_SECRET_TOKEN, ADMIN_TRIGGER_SECRET
3. Update `/srv/altyn/.env` on VPS with new values
4. Run deploy block from §D
5. Run `bash scripts/set-telegram-webhook.sh`
6. Run `bash scripts/smoke-test.sh` → expect "🎉 READY" (or all 16 checks pass)
7. Manual /start test from real phone with `?start=src_ig_online_silence`
8. Revoke previously-pasted-in-chat tokens (Cloudflare ×2, GitHub PAT) and rotate

### 4. Production deploy commands → §D above
### 5. Rollback commands → §E above
### 6. Smoke test → §F above

### 7. Launch plan first 72h

**Day 0 (after deploy):**
- Budget: 10–15 USD/day total, split equally across creatives.
- 2 ad sets (one per ad-set) × 3 creatives each:
  - Ad set A "Reels / interest = relationships, women 25–45 Tashkent" — creatives: online_silence, relationship_loop, strong_woman
  - Ad set B "Stories retargeting site visitors" — creatives: retarg_story_v1, retarg_story_v2, retarg_story_v3
- Each creative landing: `https://t.me/altyntherapybot?start=src_ig_<creative>` OR `https://altyn-therapy.uz/?utm_source=ig&utm_campaign=<creative>`
- Conversion event for optimisation: **DirectTelegramClick** (Meta CAPI `Contact`) for hot path; **BookingSubmitted** (`Lead`, 10 USD) for soft path.

**Watch first 72 h (admin dashboard `/api/leads/breakdown` + `/api/leads?temperature=HOT`):**
- CPL per creative.
- TelegramLead → QuizStart rate (target ≥ 60 %).
- QuizComplete → BookingIntent + DirectTelegramClick rate (target ≥ 25 %).
- BookingIntent → BookingSubmitted rate (target ≥ 50 %).
- HOT lead → contacted_within_30min rate (owner's SLA — target 100 %).

**Kill / scale rules:**
- After 50 impressions on a creative with 0 TelegramLead → pause it.
- After 30 TelegramLead with 0 BookingIntent + 0 DirectTelegramClick → pause it.
- Top 20 % CPL creatives → scale +50 % daily budget every 48 h while CPL stays in range.

### 8. Handoff

| Thing | Where |
|---|---|
| Source code | github.com/braindiggeruz/altyn-bot, branch `feat/quiz-conversion-v2-and-security`, PR #1 |
| Production code | `/srv/altyn/` on Linode VPS 139.162.188.102 |
| Secrets | `/srv/altyn/.env` (chmod 600 root) |
| Required env | see `.env.example` |
| API endpoints | `https://bot.altyn-therapy.uz/health`, `/api/health`, `/tg/<slug>` (Telegram only) |
| Admin endpoints | `https://admin.altyn-therapy.uz/api/auth/login`, `/api/dashboard`, `/api/leads`, `/api/leads/:id/status`, `/api/leads/breakdown` |
| Owner notifications | NOTIFY_GROUP_ID (group) + OWNER_TELEGRAM_ID (DM) — env-driven |
| Tables | `users` (extended in v5.2), `messages_log`, `broadcasts`, `analytics_events`, `admin_users`, `referrals`, `broadcast_templates`, `utm_links`, `user_tasks` |
| Check a lead | `psql -U altyn -d altyn -c "SELECT telegram_id, lead_status, scenario, source, creative FROM users ORDER BY last_active DESC LIMIT 10"` |
| Check TORNADO | `psql -U altyn -d altyn -c "SELECT tornado_segment, COUNT(*), AVG(tornado_score)::int FROM users GROUP BY 1"` |
| Check source tracking | `psql -U altyn -d altyn -c "SELECT source, creative, COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1,2 ORDER BY 3 DESC"` |

---

Контур не «куча файлов». Контур — машина:
**Instagram → боль → доверие → квиз → сценарий → заявка → Алтын → CRM → TORNADO → деньги.**
