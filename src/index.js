import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { initBot, sendWarmupMessages, sendReminders, sendBroadcast } from './bot.js';
import adminRouter from './admin-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Ensure assets directory exists
const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// ==================== TELEGRAM BOT ====================
const BOT_TOKEN = process.env.BOT_TOKEN || '8698863140:AAEZE-iDU9T9RkUwmtl00SvVzY0srM1woqw';
const bot = initBot(BOT_TOKEN);

// ==================== EXPRESS SERVER ====================
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', adminRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Serve admin panel
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Admin panel v2.0 running on port ${PORT}`);
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

// Send warmup messages every day at 10:00 AM (Almaty time ~ 4:00 UTC)
cron.schedule('0 4 * * *', () => {
  console.log('⏰ Running warmup messages...');
  sendWarmupMessages().catch(err => console.error('Warmup cron error:', err));
});

// Send reminders every 2 hours (for stuck quiz/booking users)
cron.schedule('0 */2 * * *', () => {
  console.log('⏰ Running reminders...');
  sendReminders().catch(err => console.error('Reminders cron error:', err));
});

// Check for scheduled broadcasts every minute
cron.schedule('* * * * *', async () => {
  try {
    const { getScheduledBroadcasts, updateBroadcast } = await import('./database.js');
    const scheduled = getScheduledBroadcasts();
    for (const broadcast of scheduled) {
      console.log(`📤 Sending scheduled broadcast: ${broadcast.title}`);
      updateBroadcast(broadcast.id, { status: 'sending' });
      sendBroadcast(broadcast.id).catch(err => {
        console.error(`Scheduled broadcast ${broadcast.id} error:`, err);
        updateBroadcast(broadcast.id, { status: 'error' });
      });
    }
  } catch (err) {
    // Silently ignore if no scheduled broadcasts
  }
});

// Log stats every 6 hours
cron.schedule('0 */6 * * *', async () => {
  try {
    const { getStats } = await import('./database.js');
    const stats = getStats();
    console.log('📊 Stats:', JSON.stringify({
      total: stats.total,
      quizCompleted: stats.quizCompleted,
      booked: stats.booked,
      conversionRate: stats.conversionRate
    }));
  } catch (err) {
    console.error('Stats cron error:', err);
  }
});

console.log('✅ Altyn Therapy System v2.0 started');
console.log(`🤖 Bot: @altyntherapybot`);
console.log(`🌐 Admin: http://localhost:${PORT}`);
console.log('📋 Cron jobs: warmup (10:00), reminders (every 2h), scheduled broadcasts (every 1m)');
