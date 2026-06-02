# 🛰 ALTYN — Owner Command Center (v5.2)

> Один документ, чтобы запустить машину. Прочитайте сверху вниз, выполните блоки, и реклама может стартовать.

---

## 1. Final status
**READY AFTER OWNER_ACTIONS** — код, скрипты, миграции, follow-up cron, Admin SPA "Лиды", viral loop — всё готово. Осталось ~10 минут OOB-действий.

## 2. What I shipped on PR #1
- Branch: `feat/quiz-conversion-v2-and-security`
- Commits: 6, files: 17, +2200/-210 (see `git log main..HEAD`)
- gitleaks: clean (63 commits scanned)
- New in this round (sprints 1–7 final):
  - `src/index.js` — v5.2 FOLLOWUP cron every 15 min, `runFollowupBatch()`, idempotent, opt-out aware, blocked-user auto-disable. New endpoints `/admin/v52/followup/dry-run` + `/admin/v52/followup/run-batch`.
  - `src/bot.js` — `src_share_<scenario>` deep-link parsed (source='share', creative='scenario_X'); on `quiz_completed` we queue `next_followup_at = now + 1h`; result card got a third button **«🤍 Поделиться сценарием с подругой»** (Telegram native share with prefilled text).
  - `public/index.html` — new **«Лиды (v5.2)»** tab consuming `/api/leads*`: 6 filters (q/temperature/status/scenario/source/creative), per-row temperature badge + score + direct-tg link + status-change dropdown + breakdown cards.
  - `LAUNCH_READINESS_v5.2.md` / `AUDIT_v5.2.md` — final docs.

## 3. OWNER_ACTIONS (only humans can do these)

```
[ ] 1. @BotFather → /revoke → @altyntherapybot  → save new BOT_TOKEN
[ ] 2. SSH root@139.162.188.102
[ ] 3. Edit /srv/altyn/.env with new secrets (block #4 below)
[ ] 4. Run DEPLOY BLOCK (#4)
[ ] 5. Run scripts/set-telegram-webhook.sh
[ ] 6. Run scripts/smoke-test.sh — expect 🎉 READY
[ ] 7. Phone test (block #6) — see hot lead in admin + group notification
[ ] 8. (Optional) put META_CAPI_PIXEL_ID + META_CAPI_ACCESS_TOKEN in .env when Meta CAPI is set up
[ ] 9. Revoke pasted-in-chat tokens (Cloudflare ×2 + old GitHub PAT) and rotate
```

## 4. DEPLOY BLOCK (one copy-paste, on the VPS)

```bash
# 0) safety net
ssh root@139.162.188.102
cd /srv/altyn
docker compose exec backup /usr/local/bin/backup.sh
LATEST=$(ls -t /srv/altyn/backups/altyn-*.dump.gz | head -1) && echo "Backup ready: $LATEST"

# 1) fetch v5.2 (atomic swap — only ~10s of downtime)
cd /srv
git clone -b feat/quiz-conversion-v2-and-security https://github.com/braindiggeruz/altyn-bot.git altyn-staging
cp /srv/altyn/Caddyfile          /srv/altyn-staging/Caddyfile
cp /srv/altyn/docker-compose.yml /srv/altyn-staging/docker-compose.yml
cp /srv/altyn/.env               /srv/altyn-staging/.env
chmod 600 /srv/altyn-staging/.env && chown root:root /srv/altyn-staging/.env
ln -sfn /srv/altyn/backups       /srv/altyn-staging/backups

# 2) rotate secrets in .env (edit manually with these new values)
JWT_NEW=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)
WHP_NEW=$(openssl rand -hex 24)
TST_NEW=$(openssl rand -hex 32)
ATS_NEW=$(openssl rand -hex 24)
ADP_NEW=$(openssl rand -base64 18 | tr -d '/+=' | head -c 18)
echo "--- write these into /srv/altyn-staging/.env: ---"
echo "BOT_TOKEN=<paste-new-from-BotFather>"
echo "JWT_SECRET=$JWT_NEW"
echo "WEBHOOK_SECRET_PATH=$WHP_NEW"
echo "TELEGRAM_SECRET_TOKEN=$TST_NEW"
echo "ADMIN_TRIGGER_SECRET=$ATS_NEW"
echo "ADMIN_PASSWORD=$ADP_NEW"
echo "OWNER_DIRECT_URL=https://t.me/Altyn2304"
echo "CORS_ORIGINS=https://altyn-therapy.uz,https://admin.altyn-therapy.uz,https://bot.altyn-therapy.uz"
echo "# Optional Meta CAPI (leave empty to disable):"
echo "META_CAPI_PIXEL_ID="
echo "META_CAPI_ACCESS_TOKEN="
nano /srv/altyn-staging/.env

# 3) reset admin_users so the new ADMIN_PASSWORD auto-seeds on first login
docker compose -f /srv/altyn/docker-compose.yml exec -T postgres \
  psql -U altyn -d altyn -c "DELETE FROM admin_users;"

# 4) atomic swap + rebuild
docker compose -f /srv/altyn/docker-compose.yml down
mv /srv/altyn /srv/altyn-old-$(date +%F-%H%M)
mv /srv/altyn-staging /srv/altyn
cd /srv/altyn
docker compose up -d --build app
sleep 15
docker compose logs --tail=80 app

# 5) install webhook with secret_token (script reads env from /srv/altyn/.env)
set -a; . ./.env; set +a
bash scripts/set-telegram-webhook.sh

# 6) full smoke
chmod +x scripts/smoke-test.sh
bash scripts/smoke-test.sh

# 7) verify v5.2 migrations applied
docker compose exec -T postgres psql -U altyn -d altyn -c \
  "\\d users" | grep -E "lead_status|creative|direct_telegram_click_at|booking_intent_at|next_followup_at"

# 8) optional — dry-run v5.2 follow-up cron without sending
curl -fsS -X POST -H "X-Admin-Secret: $ADMIN_TRIGGER_SECRET" \
  "https://bot.altyn-therapy.uz/admin/v52/followup/dry-run?limit=20" | python3 -m json.tool
```

## 5. ROLLBACK BLOCK (one copy-paste, if anything is wrong)

```bash
ssh root@139.162.188.102
cd /srv
docker compose -f /srv/altyn/docker-compose.yml down
mv /srv/altyn /srv/altyn-failed-$(date +%F-%H%M)
mv $(ls -td /srv/altyn-old-* | head -1) /srv/altyn
cd /srv/altyn
docker compose up -d app
sleep 15
docker compose logs --tail=80 app
# If you also need to roll back the DB:
./scripts/restore-postgres.sh /srv/altyn/backups/<pre-deploy-backup>.dump.gz
# Re-install previous webhook
set -a; . ./.env; set +a
bash scripts/set-telegram-webhook.sh
bash scripts/smoke-test.sh
```

## 6. Manual phone test (5 minutes, validates the whole machine)

```
1. Open https://t.me/altyntherapybot?start=src_ig_online_silence on your phone
2. Press «🔮 Пройти тест»                                                 → quiz starts
3. Tap through all 8 questions                                            → scenario card appears with 3 buttons
4. Press «🤍 Поделиться сценарием с подругой»                              → native Telegram share opens (cancel)
5. Press «💬 Написать Алтын напрямую»                                       → admin group: «⚡️ DIRECT TELEGRAM CLICK» with source=ig, creative=online_silence
6. Go back, press «📅 Хочу личный разбор за 10$»                            → bot asks for name → request → time
7. Fill in all three                                                       → admin group: «🔥🔥🔥 ГОРЯЧИЙ ЛИД! 🔥 HOT (score ≥60)» with "Рекомендованный первый ответ"
8. Open https://admin.altyn-therapy.uz, login → click «Лиды (v5.2)»
   → see new row: 🔥 HOT | name @user | scenario | booking_intent | ig/online_silence | direct=1 | phone | created
   → top breakdown cards show «По статусам / По источникам / По креативам / По сценариям»
9. Change status to «contacted» from dropdown                              → row updates, breakdown refreshes
```

## 7. CONVERSION MACHINE MAP

```
                   ┌───────────────────────────┐
                   │   Instagram / Meta Ads    │
                   │ (creative = online_silence│
                   │  / relationship_loop /    │
                   │  strong_woman / retarg)   │
                   └───────────┬───────────────┘
                  ┌────────────┴────────────┐
                  ▼                         ▼
     altyn-therapy.uz (CRO)        t.me/altyntherapybot?start=src_ig_<creative>
        ├── Hero 7s recognition          (TelegramLead → CAPI Lead)
        ├── Trust + Safety blocks                ▼
        ├── «Что будет за 60 мин»     ┌───────────────────────┐
        ├── 10$ value framing         │   /start parser v5.2  │ — recognises src/cmp/ad/ref/share
        ├── Sticky mobile CTA         │   stores source +     │
        └── /go/telegram bridge       │   creative + ad_id    │
              │                       └───────┬───────────────┘
              │  HOT  ───────► t.me/Altyn2304          │  SOFT
              │  (DirectTelegramClick → CAPI Contact)  ▼
              │                            ┌────────────────────┐
              │                            │   Quiz v5.2        │  QuizStart → CAPI CustomizeProduct
              │                            │   8 q, 6 scenarios │  QuizAnswer × N
              │                            │   soft Meta-safe   │
              │                            └─────┬──────────────┘
              │                                  ▼
              │                       ScenarioGenerated → CAPI ViewContent
              │                            ┌─────┴──────────────┐
              │            ┌───────────────┤  Result card v5.2  ├───────────────┐
              │            ▼               └────────────────────┘               ▼
              │   «10$ разбор» (booking)    «🤍 Поделиться с подругой»    «💬 Алтын напрямую»
              │   BookingIntent → CAPI       (viral loop:                 DirectTelegramClick →
              │   InitiateCheckout (10$)      src_share_<scenario>)        CAPI Contact
              │            ▼
              │   name → request → time
              │   BookingSubmitted → CAPI Lead (10 USD)
              │            ▼
              ▼   ┌────────────────────────────┐
        Алтын ←──┤ Owner notification         │  «🔥 HOT (score 80) — рекомендованный ответ»
                  └────────────┬───────────────┘
                               ▼
                    ┌────────────────────────┐
                    │   Admin SPA / CRM      │  /api/leads + filters + temperature + breakdown
                    │   • lead_status        │
                    │   • source/creative    │
                    │   • next_followup_at   │
                    │   • paid_at            │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │   TORNADO v5.2 cron    │  T+1h / T+24h / T+72h / T+7d, per scenario
                    │   every 15 min, opt-out│  skip paid/booked/archived/no_response/blocked
                    │   aware                │  FollowupSent event → analytics
                    └────────────┬───────────┘
                                 ▼
                          deals (paid_at) → ROI loop
```

## 8. 72h LAUNCH PLAN

**Budget:** 10–15 USD/day total, 2 ad sets × 3 creatives each.

| Ad set | Audience | Creatives | Landing | Conversion event |
|---|---|---|---|---|
| **A — Hot (cold traffic, IG Reels/Stories)** | Women 25–45, Tashkent + UZ, interests: «relationships», «psychology», «self-development» | `online_silence` / `relationship_loop` / `strong_woman` | `t.me/altyntherapybot?start=src_ig_<creative>` | `DirectTelegramClick` (CAPI **Contact**) |
| **B — Site retarget** | Visitors of altyn-therapy.uz last 14d | `retarg_story_v1` / `retarg_story_v2` / `retarg_story_v3` | `altyn-therapy.uz/?utm_source=ig&utm_campaign=<creative>` | `BookingSubmitted` (CAPI **Lead**, 10 USD) |

**Watch via admin → Лиды:**
- `lf-temperature = HOT` → ответ Алтын в 30 мин
- breakdown «По креативам» → видно какой creative приводит платных клиентов
- breakdown «По статусам» → ratio quiz_completed → booking_intent → booked

**Daily decision rules (run каждый день в одно и то же время):**
| If… | Then |
|---|---|
| Creative spent 10 USD, 0 `TelegramLead` | **PAUSE** |
| Creative spent 25 USD, 0 `BookingSubmitted` + 0 `DirectTelegramClick` | **PAUSE** |
| Creative CTR < 0.8 % after 1000 impressions | **PAUSE** |
| Cost per `BookingSubmitted` < 5 USD AND lead quality (HOT/WARM ≥ 60 %) | **+30 % budget** |
| Cost per `DirectTelegramClick` < 1.5 USD AND owner SLA ≤ 30 min on 80 % | **+30 % budget** |
| Top 20 % creatives by lead quality | **scale +50 %**, кросс-таргет на lookalikes |

**Retargeting audiences (build after day 3):**
- `quiz_completed_no_booking` — show «Хочу разбор» creative
- `direct_click_no_booking` — show "Алтын ждёт сообщение" creative
- `BookingSubmitted` payers — lookalike 1 %

## 9. NEXT BEST IMPROVEMENT (after launch)

**Витрина-результат на сайте: `altyn-therapy.uz/result/<scenario>`**
Когда женщина проходит квиз и нажимает «🤍 Поделиться сценарием с подругой», подруга получает ссылку с pre-filled `start=src_share_<scenario>`. Это уже работает. Но если на сайте появится отдельная страница `/result/<scenario>` с 200-300 слов мягкого описания сценария (без личных ответов) + большой CTA «Узнать свой сценарий» и share-buttons (Telegram, WhatsApp, Instagram Stories) — каждая женщина становится бесплатным дистрибьютором.

Метрика, на которой видно эффект: `source=share` в `/api/leads/breakdown`. Ожидаемый эффект — 20–40 % новых TelegramLead **без рекламного бюджета** через 2–3 недели после старта Meta Ads (когда первая когорта прошедших женщин начнёт делиться).

Это 1 страница в site repo + 1 коммит, ~1 час работы. Делается отдельно, не блокирует запуск рекламы.
