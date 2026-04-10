import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { initBot, sendWarmupMessages } from './bot.js';
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
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', adminRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Serve admin panel
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Admin panel running on port ${PORT}`);
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

// Send warmup messages every day at 10:00 AM
cron.schedule('0 10 * * *', () => {
  console.log('⏰ Running warmup messages...');
  sendWarmupMessages().catch(err => console.error('Warmup cron error:', err));
});

// Log stats every 6 hours
cron.schedule('0 */6 * * *', () => {
  const { getStats } = import('./database.js');
  getStats().then(stats => {
    console.log('📊 Stats:', JSON.stringify(stats));
  }).catch(() => {});
});

console.log('✅ Altyn Therapy System started');
console.log(`🤖 Bot: @altyntherapybot`);
console.log(`🌐 Admin: http://localhost:${PORT}`);
