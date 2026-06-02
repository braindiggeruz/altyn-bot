# 🔑 ALTYN — ACCESS HANDOFF (public)

> **No real secrets in this file.** Real values live in `/srv/altyn/.env` on the VPS (chmod 600, root). For an at-a-glance copy with masked previews see `ACCESS_PRIVATE.local.md` (gitignored).

---

## 1. MAIN LINKS

| Service | URL | Purpose | Login? | Credentials location | Status |
|---|---|---|---|---|---|
| Main site | https://altyn-therapy.uz | Public landing — CRO funnel entry | no | — | ✅ live (Cloudflare Pages) |
| Admin panel | https://admin.altyn-therapy.uz/ | CRM, leads, dashboard | yes (admin login) | `/srv/altyn/.env` → `ADMIN_USERNAME`/`ADMIN_PASSWORD` | ✅ live |
| Admin → Leads tab | https://admin.altyn-therapy.uz/ → sidebar «Лиды (v5.2)» | All leads with filters, temperature, score, status change | same as admin | — | ✅ live (after v5.2 deploy) |
| Bot health | https://bot.altyn-therapy.uz/health | Container readiness | no | — | ✅ public 200 |
| API health | https://bot.altyn-therapy.uz/api/health | Same payload via /api prefix | no | — | ✅ public 200 |
| Telegram bot | https://t.me/altyntherapybot | Main bot (quiz / booking / TORNADO) | no | — | ✅ live |
| Direct owner Telegram | https://t.me/Altyn2304 | Алтын лично (hot CTA target) | no | — | ✅ live |
| GitHub repo | https://github.com/braindiggeruz/altyn-bot | Source of truth | yes for write | personal PAT (see §11) | ✅ |
| PR #1 | https://github.com/braindiggeruz/altyn-bot/pull/1 | v5.2 release candidate | yes | same | ✅ open, mergeable |
| VPS | 139.162.188.102 (Linode/Akamai, Ubuntu 24.04) | Production host | yes (SSH key) | owner workstation `~/.ssh/altyn_deploy_ed25519` | ✅ |
| Cloudflare zone | altyn-therapy.uz | DNS only for bot/admin; Pages for site | yes (Cloudflare account) | Cloudflare dashboard | ✅ |
| Webhook URL pattern | `https://bot.altyn-therapy.uz/tg/${WEBHOOK_SECRET_PATH}` | Telegram → app | secret_token header | env | ✅ |
| Webhook installer | `/srv/altyn/scripts/set-telegram-webhook.sh` | Updates Telegram webhook safely | reads `/srv/altyn/.env` | — | ✅ |
| Smoke test | `/srv/altyn/scripts/smoke-test.sh` | 16-step production smoke | reads `/srv/altyn/.env` | — | ✅ |
| Backfill SQL | `/srv/altyn/scripts/v52-backfill.sql` | Warm-up existing subscribers | — | — | ✅ |
| Backup folder | `/srv/altyn/backups/altyn-*.dump.gz` | Daily pg_dump (cron) | root | — | ✅ |
| TORNADO dry-run | `POST https://bot.altyn-therapy.uz/admin/v52/followup/dry-run?limit=50` | Preview next batch | `X-Admin-Secret` header | env `ADMIN_TRIGGER_SECRET` | ✅ |
| TORNADO live batch | `POST .../admin/v52/followup/run-batch?limit=3` | Small live send | same | same | ✅ |
| Test notification | `POST .../admin/test-notify` | Ping the admin group | same | same | ✅ |

---

## 2. ADMIN ACCESS

**URL:** https://admin.altyn-therapy.uz/

**Login fields (`ADMIN_USERNAME` / `ADMIN_PASSWORD`):** stored in `/srv/altyn/.env` only.

**Important behaviour:** on first successful login the app bcrypts the password and writes a row into Postgres table `admin_users`. From that moment **changing `.env` alone does NOT change the working password** — the bcrypt hash in DB wins.

### Reset password (single command block, owner)
```bash
ssh root@139.162.188.102
cd /srv/altyn
docker compose exec -T postgres psql -U altyn -d altyn -c "DELETE FROM admin_users;"
nano /srv/altyn/.env          # set new ADMIN_PASSWORD
docker compose restart app
# Then log in once at https://admin.altyn-therapy.uz/ — admin_users will auto-seed with the new bcrypt hash.
```

### Verify admin login works
```bash
set -a; . /srv/altyn/.env; set +a
curl -fsS -X POST https://admin.altyn-therapy.uz/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json;t=json.load(sys.stdin).get('token','');print('JWT:', t[:6]+'****'+t[-6:] if t else 'NO TOKEN')"
```

### Where to see leads
Admin SPA → sidebar **«Лиды (v5.2)»**. Filters: temperature (HOT/WARM/COLD), lead_status, scenario, source, creative, text search. Inline status change via the `«Изменить статус…»` dropdown.

---

## 3. VPS ACCESS

| Item | Value |
|---|---|
| Provider | Linode / Akamai |
| IP | `139.162.188.102` |
| OS | Ubuntu 24.04 |
| SSH user | `root` |
| SSH key path | `~/.ssh/altyn_deploy_ed25519` on owner workstation |
| Project root | `/srv/altyn` |
| Env file | `/srv/altyn/.env` (chmod 600, owner root) |
| Backups | `/srv/altyn/backups/altyn-YYYY-MM-DD_HH-MM-SS.dump.gz` |

### Commands
```bash
ssh root@139.162.188.102
cd /srv/altyn

docker compose ps
docker compose logs -f app
docker compose logs -f caddy
docker compose logs -f postgres
docker compose logs -f backup

docker compose restart app          # graceful app restart
docker compose down                 # full stop
docker compose up -d --build app    # rebuild + start
```

### Manual backup right now
```bash
docker compose exec backup /usr/local/bin/backup.sh
ls -lh /srv/altyn/backups | tail -3
```

---

## 4. ENV / SECRETS INVENTORY

> Real values **never** in this file. See `/srv/altyn/.env` on VPS or `ACCESS_PRIVATE.local.md`.

| Env var | Purpose | Required? | Where stored | How to rotate |
|---|---|---|---|---|
| `BOT_TOKEN` | Telegram bot auth | yes | `/srv/altyn/.env` | @BotFather → /revoke → /token |
| `OWNER_TELEGRAM_ID` | DM target for hot-lead pings | yes | env | new numeric Telegram id |
| `OWNER_DIRECT_URL` | Hot-CTA link shown to users | yes (defaults `t.me/Altyn2304`) | env | edit value |
| `NOTIFY_GROUP_ID` | Group chat that receives lead cards | optional | env | edit value |
| `JWT_SECRET` | Signs admin JWTs (≥32 chars, no fallback) | yes | env | `openssl rand -base64 48 \| tr -d '/+=' \| head -c 64` |
| `WEBHOOK_SECRET_PATH` | Random slug in `/tg/<slug>` (≥16 chars) | yes | env | `openssl rand -hex 24` + re-run `set-telegram-webhook.sh` |
| `TELEGRAM_SECRET_TOKEN` | Sent in `X-Telegram-Bot-Api-Secret-Token`, verified by app | recommended | env | `openssl rand -hex 32` + re-run `set-telegram-webhook.sh` |
| `ADMIN_TRIGGER_SECRET` | Gates `/debug`, `/admin/v52/*`, `/admin/test-notify` | yes | env | `openssl rand -hex 24` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Bootstraps `admin_users` on first login | yes | env | see §2 reset block |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Loopback Postgres in docker-compose | yes | env | redeploy compose; pg_dump → restore is the safe path |
| `DATABASE_URL` | Convenience URL — `postgres://altyn:${POSTGRES_PASSWORD}@postgres:5432/altyn` | yes | env | derived from above |
| `CORS_ORIGINS` | Comma-separated allowed origins | yes | env | edit value |
| `META_CAPI_PIXEL_ID` | Meta Pixel id (server-side CAPI) | optional | env (empty = CAPI off) | Meta Events Manager |
| `META_CAPI_ACCESS_TOKEN` | Meta CAPI long-lived token | optional | env | Meta Events Manager → System User |
| `META_CAPI_TEST_EVENT_CODE` | Debug code for Meta Test Events | optional | env | Meta Events Manager |
| `BOT_HOSTNAME` | `bot.altyn-therapy.uz` (Caddy ACME) | yes | env / Caddyfile | DNS + Caddy reload |
| `ADMIN_HOSTNAME` | `admin.altyn-therapy.uz` | yes | env / Caddyfile | same |
| `LETSENCRYPT_EMAIL` | Notice email for LE | yes | env | edit value |
| `PORT` | Internal app port (4000) | yes | env | leave as-is |
| `BACKUP_RETENTION_DAYS` | pg_dump retention | optional (14) | env | edit value |

Generator one-liner (paste on VPS, do NOT echo to chat afterwards):
```bash
{
  echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)"
  echo "WEBHOOK_SECRET_PATH=$(openssl rand -hex 24)"
  echo "TELEGRAM_SECRET_TOKEN=$(openssl rand -hex 32)"
  echo "ADMIN_TRIGGER_SECRET=$(openssl rand -hex 24)"
  echo "ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 18)"
} >> /tmp/altyn_new_secrets.txt
chmod 600 /tmp/altyn_new_secrets.txt
# Copy into /srv/altyn/.env via nano, then `rm /tmp/altyn_new_secrets.txt`.
```

---

## 5. TELEGRAM BOT ACCESS

| Item | Value |
|---|---|
| Bot username | `@altyntherapybot` |
| Numeric id | `8698863140` (visible in /health response) |
| Owner-only action | @BotFather → `/revoke` → choose `@altyntherapybot` → new token |
| Webhook URL pattern | `https://bot.altyn-therapy.uz/tg/${WEBHOOK_SECRET_PATH}` |
| Webhook installer | `bash /srv/altyn/scripts/set-telegram-webhook.sh` |

### Inspect bot
```bash
ssh root@139.162.188.102
set -a; . /srv/altyn/.env; set +a
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | python3 -m json.tool
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | python3 -c "
import sys,json,re
r=json.load(sys.stdin); res=r['result']; res['url']=re.sub(r'/tg/[A-Za-z0-9_-]+','/tg/****',res.get('url',''))
print(json.dumps(res, indent=2, ensure_ascii=False))"
```

### Reinstall webhook (after rotating BOT_TOKEN / WEBHOOK_SECRET_PATH / TELEGRAM_SECRET_TOKEN)
```bash
bash /srv/altyn/scripts/set-telegram-webhook.sh
```

### Verify the bot end-to-end
1. `t.me/altyntherapybot?start=src_ig_online_silence` → welcome card.
2. Pass quiz (8 questions) → 3 buttons on result card.
3. Press «Хочу разбор за 10$» → fill name/request/time → admin group receives `🔥🔥🔥 ГОРЯЧИЙ ЛИД 🔥 HOT (score N)` with `Рекомендованный первый ответ`.
4. Press «Написать Алтын напрямую» → admin group receives `⚡️ DIRECT TELEGRAM CLICK`.
5. Press «🤍 Поделиться сценарием с подругой» → native Telegram share opens.
6. Open admin → Лиды → new row with all fields populated.

---

## 6. DATABASE ACCESS

Postgres lives inside `docker-compose` container, **not exposed to the internet** (loopback only).

```bash
ssh root@139.162.188.102 && cd /srv/altyn

# psql shell
docker compose exec -T postgres psql -U altyn -d altyn

# Lead distribution
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "SELECT COALESCE(lead_status,'(null)'), COUNT(*) FROM users GROUP BY 1 ORDER BY 2 DESC;"

# TORNADO segments
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "SELECT COALESCE(tornado_segment,'(null)') s, COUNT(*) FROM users GROUP BY 1 ORDER BY 2 DESC;"

# Queued follow-ups in the next 6h
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "SELECT COUNT(*) FROM users WHERE next_followup_at BETWEEN NOW() AND NOW()+INTERVAL '6 hours';"

# Recent FollowupSent / OptOut / Failed events
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "SELECT event_type, COUNT(*) FROM analytics_events
     WHERE event_type LIKE 'Followup%' AND created_at > NOW()-INTERVAL '24 hours'
     GROUP BY 1 ORDER BY 2 DESC;"

# Source / creative breakdown (last 7 days)
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "SELECT source, creative, COUNT(*) FROM users
     WHERE created_at > NOW()-INTERVAL '7 days'
     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 30;"
```

### Backup & restore
```bash
docker compose exec backup /usr/local/bin/backup.sh
LATEST=$(ls -t /srv/altyn/backups/altyn-*.dump.gz | head -1)
echo "Latest: $LATEST"

# Restore (only when needed — destructive):
gunzip -c "$LATEST" | docker compose exec -T postgres pg_restore -U altyn -d altyn --clean --if-exists
```

---

## 7. ADMIN API ENDPOINTS

> All `/api/*` need `Authorization: Bearer <JWT>`; all `/admin/*` need `X-Admin-Secret: $ADMIN_TRIGGER_SECRET`.

| Endpoint | Method | Auth | Purpose | Test |
|---|---|---|---|---|
| `/api/auth/login` | POST | none | Trade username/password for JWT | `curl -X POST .../api/auth/login -d '{"username":"…","password":"…"}'` |
| `/api/health` | GET | none | App readiness | `curl .../api/health` |
| `/api/dashboard` | GET | JWT | Aggregated stats | `curl -H "Authorization: Bearer $T" .../api/dashboard` |
| `/api/leads` | GET | JWT | Filterable leads list with `temperature`+`score` | `curl -H "Authorization: Bearer $T" ".../api/leads?temperature=HOT&limit=20"` |
| `/api/leads/breakdown` | GET | JWT | Aggregated by_status/by_source/by_creative/by_scenario | `curl -H "Authorization: Bearer $T" .../api/leads/breakdown` |
| `/api/leads/:id/status` | PATCH | JWT | Change lead_status (+notes); auto-stamps `paid_at` for `paid` | `curl -X PATCH -H "Authorization: Bearer $T" -d '{"lead_status":"contacted"}' .../api/leads/12345/status` |
| `/admin/test-notify` | POST | X-Admin-Secret | Send a test message to the admin group | `curl -X POST -H "X-Admin-Secret: $S" .../admin/test-notify` |
| `/admin/v52/followup/dry-run` | POST | X-Admin-Secret | List who would be sent (no send) | see §8 |
| `/admin/v52/followup/run-batch` | POST | X-Admin-Secret | Send a small batch now | see §8 |
| `/debug` | GET | X-Admin-Secret | Recent errors + uptime + memory | `curl -H "X-Admin-Secret: $S" .../debug` |
| `/health` | GET | none | Public health | `curl .../health` |
| `/tg/<secret>` | POST | X-Telegram-Bot-Api-Secret-Token | Telegram webhook (used by Telegram only) | — |

---

## 8. TORNADO ACCESS / CONTROL

- **Code**: `src/index.js` `runFollowupBatch()` + `src/altyn-v52-content.js` `FOLLOWUPS_V52` / `pickFollowup()`.
- **Cron**: every 15 minutes (`*/15 * * * *`).
- **Quiet hours**: 21:00–10:00 Asia/Tashkent — skipped automatically; night-scheduled `next_followup_at` snaps to 10:00 next morning.
- **Dedup**: requires `last_followup_at < NOW() - 20 hours` (≤ 1 follow-up per user per day).
- **Excluded**: `lead_status IN ('booked','paid','archived','no_response')` OR `tornado_disabled=1`.
- **/stop**: writes `tornado_disabled=1` and clears `next_followup_at`.
- **Auto-disable**: Telegram 403 (user blocked bot) flips `tornado_disabled=1`.
- **4th touch (T+7d)**: flips `lead_status = 'reactivation'` so admin sees the stalled cohort.

### Run commands
```bash
ssh root@139.162.188.102 && cd /srv/altyn
set -a; . /srv/altyn/.env; set +a

# Dry-run (preview, no send; ignores quiet hours so you can inspect any time)
curl -fsS -X POST -H "X-Admin-Secret: $ADMIN_TRIGGER_SECRET" \
  "https://bot.altyn-therapy.uz/admin/v52/followup/dry-run?limit=50" | python3 -m json.tool

# Live test on 3 users
curl -fsS -X POST -H "X-Admin-Secret: $ADMIN_TRIGGER_SECRET" \
  "https://bot.altyn-therapy.uz/admin/v52/followup/run-batch?limit=3" | python3 -m json.tool

# Verify what happened
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "SELECT event_type, COUNT(*) FROM analytics_events
     WHERE event_type LIKE 'Followup%' AND created_at > NOW()-INTERVAL '10 minutes'
     GROUP BY 1 ORDER BY 2 DESC;"
```

### Disable for a single user
```bash
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "UPDATE users SET tornado_disabled = 1, next_followup_at = NULL WHERE telegram_id = <ID>;"
```

---

## 9. META CAPI ACCESS

- **Code**: `src/meta-capi.js`. **Off by default** — activates only when both `META_CAPI_PIXEL_ID` and `META_CAPI_ACCESS_TOKEN` are non-empty.
- **No PII**: only SHA-256 of `telegram_id` is sent as `external_id`. No name, phone, message text.
- **Events fired**: `Lead`, `Contact`, `InitiateCheckout`, `Lead (10 USD)`, `Purchase`, `CustomizeProduct`, `ViewContent`.
- **Fail-tolerant**: CAPI errors never block the user funnel.

### Enable
```bash
nano /srv/altyn/.env
# Add:
#   META_CAPI_PIXEL_ID=<numeric id from Meta Events Manager>
#   META_CAPI_ACCESS_TOKEN=<server access token from System User>
#   META_CAPI_TEST_EVENT_CODE=TEST12345   # optional, only for verification
docker compose restart app
# Verify in Meta Events Manager → Test Events tab: events appear when you /start the bot from a phone.
```

---

## 10. CLOUDFLARE / DNS

| Record | Type | Value | Proxy | Notes |
|---|---|---|---|---|
| `altyn-therapy.uz` (root) | — | Cloudflare Pages | proxied | **DO NOT TOUCH** |
| `www` | — | Cloudflare Pages | proxied | **DO NOT TOUCH** |
| `bot.altyn-therapy.uz` | A | `139.162.188.102` | **DNS only (grey cloud)** | Caddy ACME needs direct |
| `admin.altyn-therapy.uz` | A | `139.162.188.102` | **DNS only (grey cloud)** | same |

- Cloudflare Pages (the site) is a **separate** Cloudflare project. Don't deploy site changes from this repo.
- Cloudflare tokens (pasted earlier in chat in clear): pasted-in-chat tokens **must be revoked and rotated** in the Cloudflare dashboard. Where to store new ones: **password manager only**, never in repo.

---

## 11. GITHUB ACCESS

| Item | Value |
|---|---|
| Repo | https://github.com/braindiggeruz/altyn-bot |
| Production branch | `main` (do not merge without owner) |
| Release candidate branch | `feat/quiz-conversion-v2-and-security` |
| PR | [#1](https://github.com/braindiggeruz/altyn-bot/pull/1) — 7 commits, 20 files, +2480/-220 |
| Pasted-in-chat PAT | `ghp_QH8r****fxMe` — **revoke + reissue** in github.com → Settings → Developer settings → Tokens |
| Store new PAT | password manager only |
| gitleaks (with `.gitleaks.toml` allowlist) | **no leaks found** on 63 commits |

### Common commands
```bash
git fetch origin
git checkout feat/quiz-conversion-v2-and-security
gitleaks detect --source . --config .gitleaks.toml --no-banner --redact
```

---

## 12. SITE CTA LINKS (audit table)

> Site repo is separate (Cloudflare Pages). Apply these fixes there.

| Page / Block | Old href | Correct href | CTA type | Tracking source | Fix? |
|---|---|---|---|---|---|
| Hero «Хочу разбор 10$» | `/go/telegram?cta=site_hero_direct` | keep | bridge_tracking | `site_hero_direct` | ✅ |
| Hero «Узнать сценарий» | `/#quiz` (inline) | `https://t.me/altyntherapybot?start=src_site_hero_quiz` | bot_funnel | `src_site_hero_quiz` | ⚠️ |
| Recognize «Пройти тест» | `/#quiz` | `https://t.me/altyntherapybot?start=src_site_recognize_quiz` | bot_funnel | `src_site_recognize_quiz` | ⚠️ |
| Recognize «Хочу разбор» | `/go/telegram?cta=recognize_direct` | keep | bridge_tracking | `recognize_direct` | ✅ |
| Why-10 «Хочу разбор» | `/go/telegram?cta=why10_direct` | keep | bridge_tracking | `why10_direct` | ✅ |
| Site-quiz result «Разобрать сценарий» | `/go/telegram?cta=quiz_result_direct` | keep | bridge_tracking | `quiz_result_direct` | ✅ |
| Site-quiz result «Оставить через бот» | `/go/telegram?cta=quiz_bot` | **`https://t.me/altyntherapybot?start=src_site_quiz_<scenario>`** | bot_funnel | `src_site_quiz_<scenario>` | ❌ label promises bot, bridge sends to direct |
| About «Хочу разбор с Алтын» | `/go/telegram?cta=about_direct` | keep | bridge_tracking | `about_direct` | ✅ |
| Final CTA «Хочу разбор» | `/go/telegram?cta=final_cta_direct` | keep | bridge_tracking | `final_cta_direct` | ✅ |
| Final CTA «Пройти тест» | `/#quiz` | `https://t.me/altyntherapybot?start=src_site_final_quiz` | bot_funnel | `src_site_final_quiz` | ⚠️ |
| Sticky mobile «Пройти тест» | `/#quiz` | `https://t.me/altyntherapybot?start=src_site_sticky_quiz` | bot_funnel | `src_site_sticky_quiz` | ⚠️ |
| Sticky mobile «Хочу разбор» | `/go/telegram?cta=sticky_mobile_direct` | keep | bridge_tracking | `sticky_mobile_direct` | ✅ |
| Hardcoded `wa.me/77077198561` anywhere | — | **REMOVE** | broken_removed | — | ✅ already absent |
| Old `@altyn_bot` mentions | — | **REMOVE** | broken_removed | — | ✅ already absent |

**Convention:**
- Soft / funnel CTAs → `https://t.me/altyntherapybot?start=src_site_<location>` → bot quiz → CRM source=`site`, creative=`<location>`.
- Hot / «Написать напрямую» → `/go/telegram?cta=<location>_direct` → bridge → `t.me/Altyn2304`. Bridge MUST log the click so `creative=<location>_direct` appears in CRM via subsequent /start.

---

## 13. OWNER DAILY ACCESS MAP

Каждое утро, 10:00 Tashkent:
1. Открыть https://admin.altyn-therapy.uz/
2. Sidebar → **«Лиды (v5.2)»**
3. Filter `temperature = 🔥 HOT` → пройти всех сверху вниз
4. Open Telegram group → найти `🔥🔥🔥 ГОРЯЧИЙ ЛИД` для каждого → скопировать «Рекомендованный первый ответ»
5. Написать клиенту в течение 30 мин (Telegram link есть в карточке)
6. В admin: status dropdown → `contacted`. После записи → `booked`. После оплаты → `paid`.

В течение дня: на каждое новое owner notification — ответ ≤ 30 мин.

Вечером, 21:00 Tashkent:
7. Breakdown карточки → топ creative по `booked / paid`
8. Решение по Ads Manager: pause / scale (правила в `OWNER_COMMAND_CENTER.md §8`)

---

## 14. FINAL ACCESS SUMMARY

| Question | Answer |
|---|---|
| A. Public links | §1 |
| B. Admin URL | https://admin.altyn-therapy.uz/ — login via `ADMIN_USERNAME` / `ADMIN_PASSWORD` |
| C. Bot link | https://t.me/altyntherapybot |
| D. VPS | `ssh root@139.162.188.102`, project `/srv/altyn`, env `/srv/altyn/.env` |
| E. GitHub | https://github.com/braindiggeruz/altyn-bot, PR #1 |
| F. Cloudflare | zone `altyn-therapy.uz`; root/www = Pages (don't touch); bot/admin = DNS only A → 139.162.188.102 |
| G. Where passwords are stored | `/srv/altyn/.env` (chmod 600) + owner password manager. Nowhere else. |
| H. Reset admin password | §2 (DELETE FROM admin_users + edit .env + restart app + login) |
| I. Rotate BOT_TOKEN | @BotFather /revoke → /token → paste into `.env` → `bash scripts/set-telegram-webhook.sh` |
| J. Run smoke-test | `cd /srv/altyn && bash scripts/smoke-test.sh` |
| K. Run backfill | §6 of `OWNER_COMMAND_CENTER.md` or `FINAL_100_READY_HANDOFF.md` §6 |
| L. Activate TORNADO | dry-run → 3-batch live → cron auto-runs every 15 min (§8 above) |
| M. What owner stores in password manager | BOT_TOKEN, JWT_SECRET, WEBHOOK_SECRET_PATH, TELEGRAM_SECRET_TOKEN, ADMIN_TRIGGER_SECRET, ADMIN_USERNAME/ADMIN_PASSWORD, POSTGRES_PASSWORD, GitHub PAT, Cloudflare tokens, Linode root password & SSH key |
