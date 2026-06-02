-- =====================================================================
-- ALTYN v5.2 backfill — safely warm up existing subscribers.
-- Idempotent. Excludes paid / booked / archived / opted-out / blocked.
-- Spread next_followup_at across a 6-hour window to avoid burst.
--
-- Usage:
--   docker compose exec -T postgres psql -U altyn -d altyn -f /tmp/v52-backfill.sql
-- Or piped:
--   docker compose exec -T postgres psql -U altyn -d altyn < scripts/v52-backfill.sql
--
-- DRY-RUN: comment out the COMMIT line; the report prints inside a transaction
-- and rolls back automatically.
-- =====================================================================

BEGIN;

-- 1) Source defaults — anyone without a source becomes 'legacy'.
UPDATE users SET source = 'legacy'
 WHERE source IS NULL OR source = '';

-- 2) lead_status backfill from existing funnel_stage / booking_status / clicks.
UPDATE users SET lead_status = 'paid'           WHERE COALESCE(lead_status,'new') = 'new'   AND paid_at IS NOT NULL;
UPDATE users SET lead_status = 'booked'         WHERE COALESCE(lead_status,'new') IN ('new','quiz_completed') AND booking_status IN ('booked','confirmed','completed');
UPDATE users SET lead_status = 'booking_intent' WHERE COALESCE(lead_status,'new') = 'new'   AND booking_intent_at IS NOT NULL;
UPDATE users SET lead_status = 'direct_clicked' WHERE lead_status IS NULL                  AND direct_telegram_click_at IS NOT NULL;
UPDATE users SET lead_status = 'quiz_completed' WHERE COALESCE(lead_status,'new') = 'new'   AND funnel_stage = 'quiz_completed';
UPDATE users SET lead_status = 'quiz_started'   WHERE COALESCE(lead_status,'new') = 'new'   AND funnel_stage = 'quiz' AND quiz_started_at IS NOT NULL;

-- 3) tornado_segment backfill from scenario (covers new v5.2 keys).
UPDATE users SET tornado_segment = scenario
 WHERE (tornado_segment IS NULL OR tornado_segment = 'generic')
   AND scenario IN ('clarity','hot_cold','strong','savior','distant','no_intimacy','fear','control','freeze');

-- 4) Schedule first follow-up for eligible existing subscribers.
--    Eligible = quiz_completed without booking, opted-in, not booked/paid/archived/blocked,
--               no follow-up sent yet, no future next_followup_at already set.
--    Spread: 6h window starting in 5 minutes, deterministic by telegram_id modulo.
UPDATE users
   SET followup_step      = COALESCE(followup_step, 0),
       next_followup_at   = NOW() + INTERVAL '5 minutes'
                            + (ABS(telegram_id) % 360) * INTERVAL '1 minute'
 WHERE next_followup_at IS NULL
   AND last_followup_at IS NULL
   AND COALESCE(tornado_disabled, 0) = 0
   AND COALESCE(lead_status, 'new') IN ('quiz_completed', 'quiz_started', 'booking_intent', 'direct_clicked')
   AND scenario IS NOT NULL
   AND COALESCE(followup_step, 0) < 4
   AND created_at > NOW() - INTERVAL '180 days';

-- 5) Old leads (>180 days, never booked) → mark as reactivation candidates,
--    DO NOT auto-schedule yet — owner must approve a reactivation campaign.
UPDATE users
   SET lead_status = 'reactivation'
 WHERE COALESCE(lead_status, 'new') IN ('new', 'quiz_started', 'quiz_completed', 'direct_clicked')
   AND created_at < NOW() - INTERVAL '180 days'
   AND booking_status NOT IN ('booked','confirmed','completed')
   AND COALESCE(tornado_disabled, 0) = 0;

-- 6) Report: by segment, what is queued.
SELECT 'lead_status' AS dim, COALESCE(lead_status,'(null)') AS k, COUNT(*) AS n
  FROM users GROUP BY 1,2 ORDER BY 3 DESC;

SELECT 'tornado_segment' AS dim, COALESCE(tornado_segment,'(null)') AS k, COUNT(*) AS n
  FROM users GROUP BY 1,2 ORDER BY 3 DESC;

SELECT 'queued for first followup in next 6h' AS dim,
       COUNT(*) AS n
  FROM users
 WHERE next_followup_at IS NOT NULL
   AND next_followup_at <= NOW() + INTERVAL '6 hours'
   AND last_followup_at IS NULL;

-- 7) COMMIT (comment out for dry-run)
COMMIT;
