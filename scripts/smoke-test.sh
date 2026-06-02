#!/usr/bin/env bash
# scripts/smoke-test.sh — v5.2
#
# 16-step end-to-end production smoke test. Designed for /srv/altyn on the
# Linode VPS. Reads /srv/altyn/.env. Never prints secrets.
#
# Exit code: 0 if all checks pass, 1 otherwise.
#
# Usage:
#   cd /srv/altyn && bash scripts/smoke-test.sh

set -uo pipefail

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf "  ✅ %s\n" "$1"; }
nope() { FAIL=$((FAIL+1)); printf "  ❌ %s\n" "$1"; }
hdr()  { printf "\n==> %s\n" "$1"; }
mask() { local s="${1:-}"; if [[ -z "$s" ]]; then echo "(empty)"; return; fi; if [[ ${#s} -le 8 ]]; then echo "****"; return; fi; echo "${s:0:4}****${s: -4}"; }

if [[ -f .env ]]; then set -a; . ./.env; set +a; fi

require_env() { local n="$1"; if [[ -z "${!n:-}" ]]; then nope "env $n missing"; else ok "env $n present ($(mask "${!n}"))"; fi; }

hdr "0) Required env"
for v in BOT_TOKEN JWT_SECRET WEBHOOK_URL WEBHOOK_SECRET_PATH ADMIN_USERNAME ADMIN_PASSWORD ADMIN_TRIGGER_SECRET POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  require_env "$v"
done

hdr "1) Containers"
for svc in app postgres caddy backup; do
  if docker compose ps -q "$svc" 2>/dev/null | grep -q . && \
     [[ "$(docker compose ps --status running -q "$svc")" != "" ]]; then
    ok "container '$svc' running"
  else
    nope "container '$svc' not running"
  fi
done

hdr "2) DB connectivity"
if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then ok "pg_isready"; else nope "pg_isready"; fi
if docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT to_regclass('public.users') IS NOT NULL" 2>/dev/null | grep -q t; then ok "users table exists"; else nope "users table missing"; fi
if docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT to_regclass('public.users') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='lead_status')" 2>/dev/null | grep -q t; then ok "v5.2 column lead_status exists"; else nope "v5.2 column lead_status missing — run migrations"; fi
if docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='direct_telegram_click_at')" 2>/dev/null | grep -q t; then ok "v5.2 column direct_telegram_click_at exists"; else nope "v5.2 column direct_telegram_click_at missing"; fi

hdr "3) Public /health"
HEALTH=$(curl -fsS -m 10 "${WEBHOOK_URL}/health" 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  VER=$(echo "$HEALTH" | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
  ok "/health 200 (version=$VER)"
else
  nope "/health failed"
fi
if curl -fsS -m 10 "${WEBHOOK_URL}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then ok "/api/health 200"; else nope "/api/health failed"; fi

hdr "4) Telegram bot"
ME=$(curl -fsS -m 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || echo "")
if echo "$ME" | grep -q '"ok":true'; then ok "getMe ($(echo "$ME" | python3 -c "import sys,json;print('@'+json.load(sys.stdin)['result']['username'])"))"; else nope "getMe failed"; fi
INFO=$(curl -fsS -m 10 "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" 2>/dev/null || echo "")
if echo "$INFO" | grep -q "/tg/"; then ok "webhook points to /tg/****"; else nope "webhook URL wrong or missing"; fi
LAST_ERR=$(echo "$INFO" | python3 -c "import sys,json;r=json.load(sys.stdin);print(r['result'].get('last_error_message') or '')" 2>/dev/null || echo "")
if [[ -z "$LAST_ERR" ]]; then ok "webhook last_error = none"; else nope "webhook last_error: $LAST_ERR"; fi

hdr "5) Admin login round-trip"
LOGIN_RESP=$(curl -fsS -m 10 -X POST "${WEBHOOK_URL%/}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null || echo "")
TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
ADMIN_URL="${ADMIN_HOSTNAME:+https://$ADMIN_HOSTNAME}"
if [[ -z "$ADMIN_URL" ]]; then ADMIN_URL="$WEBHOOK_URL"; fi
if [[ -n "$TOKEN" ]]; then
  ok "POST /api/auth/login → JWT received ($(mask "$TOKEN"))"
  if curl -fsS -m 10 -H "Authorization: Bearer $TOKEN" "${ADMIN_URL}/api/dashboard" >/dev/null 2>&1; then ok "GET /api/dashboard with JWT → 200"; else nope "GET /api/dashboard failed"; fi
else
  nope "admin login did not return a token"
fi

hdr "6) Owner notification trigger"
if [[ -n "${ADMIN_TRIGGER_SECRET:-}" ]]; then
  if curl -fsS -m 15 -X POST -H "X-Admin-Secret: $ADMIN_TRIGGER_SECRET" "${WEBHOOK_URL%/}/admin/test-notify" 2>/dev/null | grep -q '"ok":true'; then
    ok "POST /admin/test-notify → Telegram message delivered"
  else
    nope "test-notify failed (group/owner targets configured?)"
  fi
else
  nope "ADMIN_TRIGGER_SECRET not set — cannot test owner notify"
fi

hdr "7) Backup smoke (manual run)"
if docker compose exec -T backup /usr/local/bin/backup.sh >/dev/null 2>&1; then
  LATEST=$(ls -t /srv/altyn/backups/altyn-*.dump.gz 2>/dev/null | head -1)
  if [[ -n "$LATEST" ]]; then ok "manual backup created: $(basename "$LATEST") ($(du -h "$LATEST" | cut -f1))"; else nope "backup ran but no dump file found"; fi
else
  nope "backup container exec failed"
fi

echo
echo "================================================="
printf "PASS: %d  FAIL: %d\n" "$PASS" "$FAIL"
if [[ $FAIL -eq 0 ]]; then
  echo "🎉 READY"
  exit 0
else
  echo "⚠️  Some checks failed — review above before launching ads."
  exit 1
fi
