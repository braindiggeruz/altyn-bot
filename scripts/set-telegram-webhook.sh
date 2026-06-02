#!/usr/bin/env bash
# scripts/set-telegram-webhook.sh — v5.2
#
# Production-safe webhook installer.
# Reads BOT_TOKEN, WEBHOOK_URL, WEBHOOK_SECRET_PATH, TELEGRAM_SECRET_TOKEN from env
# (typically sourced from /srv/altyn/.env). NEVER prints the token.
#
# Usage on VPS:
#   cd /srv/altyn && set -a; . ./.env; set +a && bash scripts/set-telegram-webhook.sh
#
# What it does:
#   1. getMe        — verifies BOT_TOKEN
#   2. deleteWebhook — clears any old webhook (drop_pending_updates=true)
#   3. setWebhook    — installs /tg/$WEBHOOK_SECRET_PATH with secret_token header
#   4. getWebhookInfo — prints current state (token masked)
#
# Exit codes: 0 = OK, 1 = misconfig, 2 = Telegram error.

set -euo pipefail

mask() {
  local s="${1:-}"
  if [[ -z "$s" ]]; then echo "(empty)"; return; fi
  if [[ ${#s} -le 8 ]]; then echo "****"; return; fi
  echo "${s:0:4}****${s: -4}"
}

require() {
  local name="$1"
  local val="${!name:-}"
  if [[ -z "$val" ]]; then
    echo "❌ $name is not set in env" >&2
    exit 1
  fi
}

require BOT_TOKEN
require WEBHOOK_URL
require WEBHOOK_SECRET_PATH

if [[ ${#WEBHOOK_SECRET_PATH} -lt 16 ]]; then
  echo "❌ WEBHOOK_SECRET_PATH is shorter than 16 chars — refusing for security." >&2
  exit 1
fi

if [[ -z "${TELEGRAM_SECRET_TOKEN:-}" ]]; then
  echo "⚠️  TELEGRAM_SECRET_TOKEN is empty — Telegram will not send a secret header." >&2
  echo "    Strongly recommended to set it (≥32 hex chars)." >&2
fi

API="https://api.telegram.org/bot${BOT_TOKEN}"
HOOK_URL="${WEBHOOK_URL%/}/tg/${WEBHOOK_SECRET_PATH}"

echo "→ Bot token:      $(mask "$BOT_TOKEN")"
echo "→ Webhook URL:    ${WEBHOOK_URL%/}/tg/$(mask "$WEBHOOK_SECRET_PATH")"
echo "→ Secret header:  $(mask "${TELEGRAM_SECRET_TOKEN:-}")"
echo

echo "==> 1) getMe"
ME=$(curl -fsS "${API}/getMe")
echo "    $(echo "$ME" | python3 -c "import sys,json; r=json.load(sys.stdin); print('ok' if r.get('ok') else 'FAIL', '— @' + r.get('result',{}).get('username','?'))")"

echo "==> 2) deleteWebhook (drop_pending_updates=true)"
curl -fsS -X POST "${API}/deleteWebhook?drop_pending_updates=true" -o /dev/null
echo "    cleared"

echo "==> 3) setWebhook"
FORM=(
  --data-urlencode "url=${HOOK_URL}"
  --data-urlencode "max_connections=40"
  --data-urlencode "allowed_updates=[\"message\",\"callback_query\",\"my_chat_member\",\"chat_member\"]"
)
if [[ -n "${TELEGRAM_SECRET_TOKEN:-}" ]]; then
  FORM+=(--data-urlencode "secret_token=${TELEGRAM_SECRET_TOKEN}")
fi
SET=$(curl -fsS -X POST "${API}/setWebhook" "${FORM[@]}")
echo "    $(echo "$SET" | python3 -c "import sys,json; r=json.load(sys.stdin); print('ok' if r.get('ok') else 'FAIL', '—', r.get('description',''))")"

echo "==> 4) getWebhookInfo"
INFO=$(curl -fsS "${API}/getWebhookInfo")
python3 - <<PY
import json, re, sys
r = json.loads('''$INFO''')
res = r.get('result', {})
url = res.get('url', '')
url = re.sub(r'/tg/[A-Za-z0-9_-]+', '/tg/****', url)
print(f"    url:                 {url}")
print(f"    pending_update_count: {res.get('pending_update_count')}")
print(f"    last_error_message:  {res.get('last_error_message') or 'none'}")
print(f"    last_error_date:     {res.get('last_error_date') or 'none'}")
print(f"    max_connections:     {res.get('max_connections')}")
print(f"    allowed_updates:     {res.get('allowed_updates')}")
PY

echo
echo "✅ Webhook installed. Token never printed."
