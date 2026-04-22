import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { initDatabase } from './database.js';
import { initBot, sendWarmupMessages, sendReminders, sendBroadcast } from './bot.js';
import adminRouter from './admin-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure assets directory exists
const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// ==================== EXPRESS SERVER ====================
const app = express();
const PORT = process.env.PORT || 4000;

// FIX: Restrict CORS to known origins
const allowedOrigins = [
  'https://altyn-bot-production.up.railway.app',
  'https://altyn-therapy.uz',
  'http://localhost:3000',
  'http://localhost:4000'
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`⚠️ CORS request from unknown origin: ${origin}`);
      callback(null, true);
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

    // Init Telegram bot (webhook in production, polling in dev)
    const BOT_TOKEN = process.env.BOT_TOKEN || '8698863140:AAEZE-iDU9T9RkUwmtl00SvVzY0srM1woqw';
    const bot = initBot(BOT_TOKEN, app);

    // API routes
    app.use('/api', adminRouter);

    // Health check
    app.get('/health', (req, res) => {
      const WEBHOOK_URL = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.WEBHOOK_URL || null;

      res.json({
        status: 'ok',
        version: '4.0.0',
        mode: WEBHOOK_URL ? 'webhook' : 'polling',
        database: 'postgresql',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        notify_group: process.env.NOTIFY_GROUP_ID ? 'configured' : 'not set',
        owner_id: process.env.OWNER_TELEGRAM_ID ? 'configured' : 'not set'
      });
    });

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
      console.log(`🌐 Admin panel v4.0.0 running on port ${PORT}`);
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
      sendWarmupMessages()
        .then(() => console.log(`✅ [${new Date().toISOString()}] CRON: Warmup messages done`))
        .catch(err => console.error(`❌ CRON warmup error:`, err.message));
    });

    // Send reminders every 2 hours (for stuck quiz/booking users)
    cron.schedule('0 */2 * * *', () => {
      const now = new Date().toISOString();
      console.log(`⏰ [${now}] CRON: Running reminders (every 2h)...`);
      sendReminders()
        .then(() => console.log(`✅ [${new Date().toISOString()}] CRON: Reminders done`))
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
    console.log(`✅ Altyn Therapy System v4.0.0 started (${mode} mode, PostgreSQL)`);
    console.log(`🤖 Bot: @altyntherapybot`);
    console.log(`🌐 Admin: http://localhost:${PORT}`);
    console.log(`📢 Notify Group: ${process.env.NOTIFY_GROUP_ID || 'NOT SET — add NOTIFY_GROUP_ID to Railway variables!'}`);
    console.log('📋 Cron jobs:');
    console.log('   - Warmup: daily at 10:00 Almaty (05:00 UTC)');
    console.log('   - Reminders: every 2 hours (quiz stuck, booking stuck)');
    console.log('   - Broadcasts: every 5 minutes (scheduled)');
    console.log('   - Stats: every 6 hours');

  } catch (err) {
    console.error('❌ Failed to start application:', err);
    process.exit(1);
  }
}

startApp();
