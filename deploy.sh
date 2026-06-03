#!/usr/bin/env bash
# =============================================================================
# ALTYN Therapy Bot — VPS deploy script (run on 139.162.188.102)
# -----------------------------------------------------------------------------
# Pulls the merged v5.2 capture/hot-flow/analytics fixes from main and rolls
# them out on the production VPS without downtime longer than ~10 seconds.
#
# Usage (on the VPS as root):
#     curl -fsSL https://raw.githubusercontent.com/braindiggeruz/altyn-bot/main/deploy.sh \
#       -o /tmp/deploy-altyn.sh && bash /tmp/deploy-altyn.sh
# or simply run the steps below by hand:
# =============================================================================
set -euo pipefail

cd /srv/altyn

echo ">> 1/6  Pull latest bot code"
# If the bot's git working tree is the altyn-bot repo:
if [ -d /srv/altyn/altyn-bot/.git ]; then
  cd /srv/altyn/altyn-bot
  git fetch origin main
  git reset --hard origin/main
  cd /srv/altyn
else
  echo "   (no /srv/altyn/altyn-bot/.git — assuming docker-compose builds from a different path; rebuild will fetch fresh image)"
fi

echo ">> 2/6  Backup the database before migration"
TS=$(date -u +%Y%m%d-%H%M%S)
mkdir -p /srv/altyn/backups
docker compose exec -T postgres pg_dump -U altyn -d altyn | gzip > "/srv/altyn/backups/altyn-pre-v52-${TS}.dump.gz"
ls -lh "/srv/altyn/backups/altyn-pre-v52-${TS}.dump.gz"

echo ">> 3/6  Rebuild and restart the bot container"
docker compose build app
docker compose up -d app

echo ">> 4/6  Wait for /health to report version 5.2.0"
for i in 1 2 3 4 5 6 7 8 9 10; do
  V=$(curl -fsS -m 5 https://bot.altyn-therapy.uz/health | python3 -c "import json,sys;print(json.load(sys.stdin).get('version'))" 2>/dev/null || echo "")
  echo "   attempt $i: version=$V"
  if [ "$V" = "5.2.0" ]; then break; fi
  sleep 3
done

echo ">> 5/6  Verify migration applied (new columns present)"
docker compose exec -T postgres psql -U altyn -d altyn -c "\d users" \
  | grep -E "start_param|creative|lead_status|telegram_started_at|booking_intent_at|booking_submitted_at|owner_notified_at|direct_owner_clicked_at" \
  || { echo "!! Migration columns missing!"; exit 1; }

echo ">> 6/6  Smoke test analytics events table"
docker compose exec -T postgres psql -U altyn -d altyn -c "SELECT event_type, COUNT(*) FROM analytics_events WHERE created_at > NOW() - INTERVAL '1 day' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;"

echo ""
echo "=========================================================================="
echo "✅ ALTYN bot v5.2 deployed."
echo ""
echo "Next: send /start to @altyntherapybot from a test account, then:"
echo "  docker compose exec -T postgres psql -U altyn -d altyn -c \\"
echo "    \"SELECT telegram_id, username, first_name, start_param, source, creative, lead_status, created_at FROM users ORDER BY created_at DESC LIMIT 5;\""
echo ""
echo "TORNADO dry-run (safe, no sends):"
echo "  curl -fsS -X POST -H \"X-Admin-Secret: \$ADMIN_TRIGGER_SECRET\" \\"
echo "    'https://bot.altyn-therapy.uz/admin/v52/followup/dry-run?limit=50' | python3 -m json.tool"
echo ""
echo "TORNADO live batch of 3 (real send):"
echo "  curl -fsS -X POST -H \"X-Admin-Secret: \$ADMIN_TRIGGER_SECRET\" \\"
echo "    'https://bot.altyn-therapy.uz/admin/v52/followup/run-batch?limit=3' | python3 -m json.tool"
echo "=========================================================================="
