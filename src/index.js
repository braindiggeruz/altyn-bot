import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { initDatabase } from './database.js';
import { initBot, sendWarmupMessages, sendReminders, sendBroadcast, sendTornadoReactivation, setBot, runOnce, notifyAdmin } from './bot.js';
import { TORNADO_MESSAGES } from './content.js';
import adminRouter from './admin-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure assets directory exists
const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// ==================== EXPRESS SERVER ====================
const app = express();
const PORT = process.env.PORT || 4000;

// Global bot instance will be set by initBot()

// SECURITY v5.2: CORS origins are now env-driven (CORS_ORIGINS=comma-separated).
// Removed the hardcoded Railway origin. Falls back to the public hostnames.
const allowedOrigins = (process.env.CORS_ORIGINS || 'https://altyn-therapy.uz,https://admin.altyn-therapy.uz,https://bot.altyn-therapy.uz')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`⚠️ CORS blocked request from unknown origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// IMPORTANT: raw JSON body parser MUST be before webhook route
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ==================== INIT DATABASE & BOT ====================
async function startApp() {
  try {
    // Initialize PostgreSQL database (create tables, run migrations)
    await initDatabase();
    console.log('✅ Database ready');

    // SECURITY v5.2: BOT_TOKEN MUST come from env. No hardcoded fallback —
    // a leaked production token in git history led to revocation. Fail-fast.
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(BOT_TOKEN)) {
      console.error('❌ FATAL: BOT_TOKEN env var missing or malformed. Refusing to start.');
      process.exit(1);
    }
    const botInstance = initBot(BOT_TOKEN, app);
    // Make sure bot is available globally for cron jobs
    setBot(botInstance);

    // API routes
    app.use('/api', adminRouter);

    // SECURITY v5.2: /debug is gated behind ADMIN_TRIGGER_SECRET — it leaks stack traces and
    // memory layout. Fail-closed when secret not configured.
    const errorLog = [];
    const MAX_ERRORS = 50;
    global.__addError = (source, msg, stack) => {
      errorLog.unshift({ time: new Date().toISOString(), source, msg, stack: stack?.substring(0, 500) });
      if (errorLog.length > MAX_ERRORS) errorLog.length = MAX_ERRORS;
    };
    app.get('/debug', (req, res) => {
      const expected = process.env.ADMIN_TRIGGER_SECRET;
      if (!expected) return res.status(503).json({ error: 'ADMIN_TRIGGER_SECRET not set on server' });
      if (req.get('X-Admin-Secret') !== expected) return res.status(401).json({ error: 'unauthorized' });
      res.json({
        errors: errorLog,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      });
    });

    // ===== Admin-only manual cron triggers (great for prod smoke tests) =====
    // Auth: pass header  X-Admin-Secret: <process.env.ADMIN_TRIGGER_SECRET>
    // If env var is unset, the endpoint refuses to run — fail closed.
    const triggerSecret = process.env.ADMIN_TRIGGER_SECRET || null;
    function requireSecret(req, res) {
      if (!triggerSecret) { res.status(503).json({ error: 'ADMIN_TRIGGER_SECRET not set on server' }); return false; }
      if (req.get('X-Admin-Secret') !== triggerSecret) { res.status(401).json({ error: 'unauthorized' }); return false; }
      return true;
    }
    app.post('/admin/trigger/warmup', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const r = await runOnce('manual:warmup', () => sendWarmupMessages());
      res.json({ ok: true, result: r });
    });
    app.post('/admin/trigger/reminders', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const r = await runOnce('manual:reminders', () => sendReminders());
      res.json({ ok: true, result: r });
    });
    app.post('/admin/trigger/tornado', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const r = await runOnce('manual:tornado', () => sendTornadoReactivation({ source: 'manual' }));
      res.json({ ok: true, result: r });
    });

    // v4.9.2: TORNADO safety endpoints — dry-run, test-to-admin, small-batch.
    // All three require X-Admin-Secret. NONE of them touch booked/completed users
    // or users that opted out (tornado_disabled=1 or exit_reason set).
    //
    //   POST /admin/tornado/dry-run            — returns candidate list, no DB write, no send
    //   POST /admin/tornado/test               — sends ONLY to admin (OWNER_TELEGRAM_ID by default,
    //                                            or ?telegram_id=<ID> override). Live send.
    //   POST /admin/tornado/run-batch?limit=N  — real send capped at N (1..100, default 5)
    //
    app.post('/admin/tornado/dry-run', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 100);
      const r = await sendTornadoReactivation({ dryRun: true, limit, source: 'dry-run' });
      res.json({ ok: true, result: r });
    });
    app.post('/admin/tornado/test', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const targetParam = req.query.telegram_id || req.body?.telegram_id || process.env.OWNER_TELEGRAM_ID;
      const targetId = parseInt(targetParam, 10);
      if (!targetId) return res.status(400).json({ ok: false, error: 'no telegram_id (set OWNER_TELEGRAM_ID or pass ?telegram_id=)' });
      const r = await runOnce(`manual:tornado:test:${targetId}`, () => sendTornadoReactivation({
        onlyTelegramIds: [targetId],
        limit: 1,
        source: 'test'
      }));
      res.json({ ok: true, target: targetId, result: r });
    });
    app.post('/admin/tornado/run-batch', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const limit = Math.min(Math.max(parseInt(req.query.limit || '5', 10) || 5, 1), 500);
      const minIdleDays = req.query.min_idle_days !== undefined ? parseInt(req.query.min_idle_days, 10) : 7;
      const r = await runOnce(`manual:tornado:batch:${limit}:${minIdleDays}`, () => sendTornadoReactivation({
        limit, minIdleDays, source: 'batch'
      }));
      res.json({ ok: true, limit, minIdleDays, result: r });
    });

    // v5.0: Conversion-machine ops endpoints.
    app.get('/admin/tornado/stats', async (req, res) => {
      if (!requireSecret(req, res)) return;
      try {
        const { pool } = await import('./database.js');
        const overall = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE tornado_day BETWEEN 1 AND 30) AS in_pipeline,
            COUNT(*) FILTER (WHERE tornado_day = 30) AS completed,
            COUNT(*) FILTER (WHERE tornado_disabled = 1) AS unsubscribed,
            COUNT(*) FILTER (WHERE booking_status IN ('booked','confirmed','completed')) AS booked,
            COUNT(*) FILTER (WHERE tornado_score >= 50) AS hot_leads,
            COALESCE(SUM(tornado_click_count), 0) AS total_clicks,
            COALESCE(SUM(tornado_reply_count), 0) AS total_replies
          FROM users
        `);
        const byDay = await pool.query(`
          SELECT tornado_day, COUNT(*) AS users
          FROM users WHERE tornado_day BETWEEN 1 AND 30
          GROUP BY tornado_day ORDER BY tornado_day
        `);
        const bySegment = await pool.query(`
          SELECT COALESCE(tornado_segment, 'generic') AS seg, COUNT(*) AS users,
                 AVG(tornado_score)::numeric(10,2) AS avg_score
          FROM users WHERE tornado_day > 0
          GROUP BY 1 ORDER BY 2 DESC
        `);
        const events = await pool.query(`
          SELECT event_type, COUNT(*) AS n
          FROM analytics_events
          WHERE event_type LIKE 'tornado_%' AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY 2 DESC
        `);
        const ctr = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM analytics_events WHERE event_type='tornado_sent' AND created_at >= NOW() - INTERVAL '30 days') AS sent,
            (SELECT COUNT(*) FROM analytics_events WHERE event_type='tornado_click' AND created_at >= NOW() - INTERVAL '30 days') AS clicks,
            (SELECT COUNT(*) FROM analytics_events WHERE event_type='tornado_reply' AND created_at >= NOW() - INTERVAL '30 days') AS replies
        `);
        const top = await pool.query(`
          SELECT telegram_id, first_name, username, tornado_segment, tornado_day, tornado_score,
                 tornado_click_count, tornado_reply_count, tornado_disabled, booking_status,
                 last_tornado_click, last_tornado_reply
          FROM users WHERE tornado_score > 0
          ORDER BY tornado_score DESC LIMIT 25
        `);
        res.json({
          ok: true,
          overall: overall.rows[0],
          ctr_30d: ctr.rows[0],
          by_day: byDay.rows,
          by_segment: bySegment.rows,
          events_30d: events.rows,
          top_engaged: top.rows,
          tornado_enabled: process.env.TORNADO_ENABLED !== '0'
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    app.post('/admin/tornado/pause-all', (req, res) => {
      if (!requireSecret(req, res)) return;
      // Soft pause: set TORNADO_ENABLED=0 in process env. Survives until next restart;
      // for permanent pause, also set the Railway env var to '0'.
      process.env.TORNADO_ENABLED = '0';
      res.json({ ok: true, paused: true, note: 'In-process. For persistent pause set Railway env TORNADO_ENABLED=0.' });
    });
    app.post('/admin/tornado/resume', (req, res) => {
      if (!requireSecret(req, res)) return;
      process.env.TORNADO_ENABLED = '1';
      res.json({ ok: true, paused: false });
    });

    // Quick smoke test: dispatch a test message to NOTIFY_GROUP_ID + OWNER_TELEGRAM_ID.
    // Use to verify group notifications work end-to-end without going through the funnel.
    app.post('/admin/test-notify', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const env_targets = {
        NOTIFY_GROUP_ID: process.env.NOTIFY_GROUP_ID || null,
        OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID || null
      };
      const stamp = new Date().toISOString();
      const r = await notifyAdmin(`🔥 *TEST notify*\n\nServer time: ${stamp}\nIf you see this in the group — group notifications work ✅`);
      res.json({ ok: true, result: r, env_targets });
    });

    // Health check (alias /api/health for compatibility with admin panel)
    function healthPayload() {
      const WEBHOOK_URL = process.env.WEBHOOK_URL
        || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
      return {
        status: 'ok',
        version: '5.2.0',
        mode: WEBHOOK_URL ? 'webhook' : 'polling',
        database: 'postgresql',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        notify_group: process.env.NOTIFY_GROUP_ID ? 'configured' : 'not set',
        owner_id: process.env.OWNER_TELEGRAM_ID ? 'configured' : 'not set'
      };
    }
    app.get('/health', (req, res) => res.json(healthPayload()));
    app.get('/api/health', (req, res) => res.json(healthPayload()));

    // Serve admin panel (catch-all — must be LAST route)
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });

    // FIX: Global unhandled error handlers to prevent crashes
    process.on('uncaughtException', (err) => {
      console.error('❌ Uncaught Exception:', err.message, err.stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    });

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 Admin panel v4.8.0 running on port ${PORT}`);
    }).on('error', (err) => {
      console.error('Server error:', err.message);
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} is busy, trying ${parseInt(PORT) + 1}...`);
        app.listen(parseInt(PORT) + 1, '0.0.0.0', () => {
          console.log(`🌐 Admin panel running on port ${parseInt(PORT) + 1}`);
        });
      }
    });

    // ==================== CRON JOBS ====================

    // Send warmup messages every day at 10:00 AM Almaty time (UTC+5 = 05:00 UTC)
    cron.schedule('0 5 * * *', () => {
      const now = new Date().toISOString();
      console.log(`⏰ [${now}] CRON: Running warmup messages (10:00 Almaty)...`);
      runOnce('cron:warmup', () => sendWarmupMessages())
        .then(r => console.log(`✅ [${new Date().toISOString()}] CRON: warmup`, JSON.stringify(r)))
        .catch(err => console.error(`❌ CRON warmup error:`, err.message));
    });

    // Send reminders every 2 hours (for stuck quiz/booking users)
    cron.schedule('0 */2 * * *', () => {
      const now = new Date().toISOString();
      console.log(`⏰ [${now}] CRON: Running reminders (every 2h)...`);
      runOnce('cron:reminders', () => sendReminders())
        .then(r => console.log(`✅ [${new Date().toISOString()}] CRON: reminders`, JSON.stringify(r)))
        .catch(err => console.error(`❌ CRON reminders error:`, err.message));
    });

    // Check for scheduled broadcasts every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      try {
        const { getScheduledBroadcasts, updateBroadcast } = await import('./database.js');
        const scheduled = await getScheduledBroadcasts();
        if (scheduled.length > 0) {
          console.log(`⏰ [${new Date().toISOString()}] CRON: Found ${scheduled.length} scheduled broadcast(s)`);
        }
        for (const broadcast of scheduled) {
          console.log(`📤 Sending scheduled broadcast: ${broadcast.title}`);
          await updateBroadcast(broadcast.id, { status: 'sending' });
          sendBroadcast(broadcast.id).catch(err => {
            console.error(`Scheduled broadcast ${broadcast.id} error:`, err);
            updateBroadcast(broadcast.id, { status: 'error' });
          });
        }
      } catch (err) {
        console.error('CRON broadcasts error:', err.message);
      }
    });

    // 🌪️ TORNADO: Send reactivation messages daily at 10:00 AM Almaty (UTC+5 = 05:00 UTC)
    // Runs AFTER warmup messages (warmup at 05:00, tornado at 05:30)
    cron.schedule('30 5 * * *', () => {
      const now = new Date().toISOString();
      console.log(`⏰ [${now}] CRON: Running TORNADO reactivation (10:30 Almaty)...`);
      runOnce('cron:tornado', () => sendTornadoReactivation())
        .then(r => console.log(`✅ [${new Date().toISOString()}] CRON: TORNADO`, JSON.stringify(r)))
        .catch(err => console.error(`❌ CRON TORNADO error:`, err.message));
    });

    // ====================================================================
    // v5.2 — FOLLOWUP cron (T+1h / T+24h / T+72h / T+7d, scenario-tailored)
    // Driven by users.next_followup_at + users.followup_step. Idempotent.
    // Skips: paid, booked, archived, no_response, opted-out (tornado_disabled=1).
    // Quiet hours: 21:00–10:00 Asia/Tashkent — reschedule next_followup_at to 10:00 local.
    // Manual control via POST /admin/v52/followup/{dry-run,run-batch} (admin secret).
    // ====================================================================
    function isQuietHourTashkent() {
      // Asia/Tashkent = UTC+5, no DST. We want to send only 10:00–21:00 local.
      const hourLocal = (new Date().getUTCHours() + 5) % 24;
      return hourLocal < 10 || hourLocal >= 21;
    }
    function nextSendAtTashkent10() {
      const now = new Date();
      const hourLocal = (now.getUTCHours() + 5) % 24;
      const ms = now.getTime();
      // If we're already past 10:00 local, schedule next 10:00 tomorrow; otherwise today's 10:00.
      let delta;
      if (hourLocal < 10) {
        delta = (10 - hourLocal) * 3600e3 - now.getUTCMinutes() * 60e3;
      } else {
        delta = (24 - hourLocal + 10) * 3600e3 - now.getUTCMinutes() * 60e3;
      }
      return new Date(ms + Math.max(delta, 60e3));
    }
    async function runFollowupBatch({ dryRun = false, limit = 50, ignoreQuietHours = false } = {}) {
      const { pool } = await import('./database.js');
      const { pickFollowup } = await import('./altyn-v52-content.js');
      if (!ignoreQuietHours && isQuietHourTashkent() && !dryRun) {
        return { dry_run: false, candidates: 0, sent: 0, skipped: 0, failed: 0, reason: 'quiet_hours_21_to_10_tashkent' };
      }
      const due = await pool.query(`
        SELECT telegram_id, scenario, COALESCE(followup_step, 0) AS followup_step,
               last_followup_at
        FROM users
        WHERE next_followup_at IS NOT NULL
          AND next_followup_at <= NOW()
          AND COALESCE(tornado_disabled, 0) = 0
          AND COALESCE(lead_status, 'new') NOT IN ('booked','paid','archived','no_response')
          AND COALESCE(followup_step, 0) < 4
          AND (last_followup_at IS NULL OR last_followup_at < NOW() - INTERVAL '20 hours')
        ORDER BY next_followup_at ASC
        LIMIT $1
      `, [Math.min(Math.max(limit, 1), 100)]);

      const nextDelaysMs = [3600e3, 86400e3, 86400e3 * 3, 86400e3 * 7];
      const result = { dry_run: dryRun, candidates: due.rows.length, sent: 0, skipped: 0, failed: 0, samples: [] };

      for (const u of due.rows) {
        const { text, slot, key } = pickFollowup(u.scenario, u.followup_step);
        if (!text) { result.skipped++; continue; }
        if (dryRun) {
          result.samples.push({ telegram_id: u.telegram_id, scenario: u.scenario || null, key, slot, step: u.followup_step });
          continue;
        }
        try {
          const optoutHint = '\n\n_Если неактуально — нажмите /stop, и я больше не пишу._';
          await botInstance.sendMessage(u.telegram_id, text + optoutHint, { parse_mode: 'Markdown' });
          const nextStep = (u.followup_step || 0) + 1;
          let nextAt = nextStep < 4 ? new Date(Date.now() + nextDelaysMs[nextStep]) : null;
          // Snap night → 10:00 next-morning Tashkent
          if (nextAt) {
            const hLocal = (nextAt.getUTCHours() + 5) % 24;
            if (hLocal < 10 || hLocal >= 21) nextAt = nextSendAtTashkent10();
          }
          // When the 4th touch lands, flip lead_status to 'reactivation' so admin sees it.
          const reactivationPatch = nextStep >= 4 ? ", lead_status = COALESCE(NULLIF(lead_status,'paid'), 'reactivation')" : '';
          await pool.query(
            `UPDATE users SET followup_step=$1, last_followup_at=NOW(), next_followup_at=$2${reactivationPatch} WHERE telegram_id=$3`,
            [nextStep, nextAt, u.telegram_id]
          );
          await pool.query(
            "INSERT INTO analytics_events (event_type, user_telegram_id, data) VALUES ('FollowupSent', $1, $2)",
            [u.telegram_id, JSON.stringify({ slot, key, step: nextStep })]
          );
          result.sent++;
        } catch (err) {
          result.failed++;
          console.warn(`[v52-followup] ${u.telegram_id} failed:`, err.message);
          if (err.response?.statusCode === 403 || /blocked/i.test(err.message || '')) {
            await pool.query('UPDATE users SET tornado_disabled = 1, next_followup_at = NULL WHERE telegram_id = $1', [u.telegram_id]);
            await pool.query("INSERT INTO analytics_events (event_type, user_telegram_id, data) VALUES ('FollowupOptOut', $1, '{\"reason\":\"blocked\"}')", [u.telegram_id]);
          } else {
            await pool.query("UPDATE users SET next_followup_at = NOW() + INTERVAL '30 minutes' WHERE telegram_id = $1", [u.telegram_id]);
            await pool.query("INSERT INTO analytics_events (event_type, user_telegram_id, data) VALUES ('FollowupFailed', $1, $2)", [u.telegram_id, JSON.stringify({ msg: String(err.message || '').slice(0,200) })]);
          }
        }
      }
      return result;
    }

    cron.schedule('*/15 * * * *', () => {
      runOnce('cron:v52-followup', () => runFollowupBatch({ dryRun: false, limit: 30 }))
        .then(r => { if (r?.sent || r?.failed) console.log(`✅ [v52-followup]`, JSON.stringify(r)); })
        .catch(err => console.error(`❌ CRON v52-followup error:`, err.message));
    });

    app.post('/admin/v52/followup/dry-run', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 100);
      try { const r = await runFollowupBatch({ dryRun: true, limit, ignoreQuietHours: true }); res.json({ ok: true, result: r }); }
      catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });
    app.post('/admin/v52/followup/run-batch', async (req, res) => {
      if (!requireSecret(req, res)) return;
      const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 100);
      const force = String(req.query.ignore_quiet_hours || '') === '1';
      try { const r = await runFollowupBatch({ dryRun: false, limit, ignoreQuietHours: force }); res.json({ ok: true, result: r }); }
      catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // 🛡️ STEEL E2E TESTS: Run daily at 04:00 AM Almaty (UTC+5 = 23:00 UTC previous day)
    // Runs BEFORE warmup messages to detect issues early
    //     cron.schedule('0 23 * * *', async () => {
    //       try {
    //         const now = new Date().toISOString();
    //         console.log(`⏰ [${now}] CRON: Running STEEL E2E TESTS (04:00 Almaty)...`);
    //         const { spawn } = await import('child_process');
    //         const test = spawn('node', ['../e2e-steel-tests.js'], { cwd: __dirname });
    //         test.on('close', (code) => {
    //           if (code === 0) {
    //             console.log(`✅ [${new Date().toISOString()}] CRON: E2E TESTS passed`);
    //           } else {
    //             console.error(`❌ [${new Date().toISOString()}] CRON: E2E TESTS failed with code ${code}`);
    //           }
    //         });
    //       } catch (err) {
    //         console.error('CRON E2E tests error:', err.message);
    //       }
    //     });
    // 
    // Log stats every 6 hours
    cron.schedule('0 */6 * * *', async () => {
      try {
        const { getStats } = await import('./database.js');
        const stats = await getStats();
        console.log(`📊 [${new Date().toISOString()}] CRON Stats:`, JSON.stringify({
          total: stats.total,
          quizCompleted: stats.quizCompleted,
          booked: stats.booked,
          conversionRate: stats.conversionRate
        }));
      } catch (err) {
        console.error('CRON stats error:', err.message);
      }
    });

    const mode = process.env.RAILWAY_PUBLIC_DOMAIN ? 'WEBHOOK' : 'POLLING';
    console.log(`✅ Altyn Therapy System v4.8.0 started (${mode} mode, PostgreSQL)`);
    console.log(`🤖 Bot: @altyntherapybot`);
    console.log(`🌐 Admin: http://localhost:${PORT}`);
    console.log(`📢 Notify Group: ${process.env.NOTIFY_GROUP_ID || 'NOT SET — add NOTIFY_GROUP_ID to Railway variables!'}`);
    console.log('📋 Cron jobs:');
    console.log('   - Warmup: daily at 10:00 Almaty (05:00 UTC)');
    console.log('   - Reminders: every 2 hours (quiz stuck, booking stuck)');
    console.log('   - Broadcasts: every 5 minutes (scheduled)');
    console.log('   - Stats: every 6 hours');
    console.log('   - 🌪️ TORNADO: daily at 10:30 Almaty (05:30 UTC)');
    console.log(`   - TORNADO messages: ${TORNADO_MESSAGES?.length || 30} days loaded`);

  } catch (err) {
    console.error('❌ Failed to start application:', err);
    process.exit(1);
  }
}

startApp();
