import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  getStats, getAllUsers, getUser, updateUser,
  createBroadcast, getBroadcasts, updateBroadcast, getBroadcastUsers,
  logEvent
} from './database.js';
import { sendBroadcast } from './bot.js';
import db from './database.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'altyn-admin-secret-2024';

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== AUTH ====================

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);

  if (!admin) {
    // Auto-create first admin
    const count = db.prepare('SELECT COUNT(*) as count FROM admin_users').get().count;
    if (count === 0 && username && password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(username, hash);
      const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, username, message: 'Admin account created' });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username: admin.username, role: admin.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: admin.username });
});

router.get('/auth/me', authMiddleware, (req, res) => {
  res.json(req.admin);
});

// ==================== DASHBOARD ====================

router.get('/dashboard', authMiddleware, (req, res) => {
  const stats = getStats();
  res.json(stats);
});

router.get('/dashboard/funnel', authMiddleware, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const started = db.prepare("SELECT COUNT(*) as c FROM users WHERE funnel_stage != 'new'").get().c;
  const quizStarted = db.prepare("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('quiz','quiz_completed','booking','booked','completed')").get().c;
  const quizCompleted = db.prepare("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('quiz_completed','booking','booked','completed')").get().c;
  const bookingStarted = db.prepare("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('booking','booked','completed')").get().c;
  const booked = db.prepare("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('booked','completed')").get().c;
  const completed = db.prepare("SELECT COUNT(*) as c FROM users WHERE funnel_stage = 'completed'").get().c;

  res.json({
    funnel: [
      { stage: 'Всего пользователей', count: total, pct: 100 },
      { stage: 'Начали (/start)', count: started, pct: total ? Math.round(started / total * 100) : 0 },
      { stage: 'Начали квиз', count: quizStarted, pct: total ? Math.round(quizStarted / total * 100) : 0 },
      { stage: 'Завершили квиз', count: quizCompleted, pct: total ? Math.round(quizCompleted / total * 100) : 0 },
      { stage: 'Начали запись', count: bookingStarted, pct: total ? Math.round(bookingStarted / total * 100) : 0 },
      { stage: 'Записались', count: booked, pct: total ? Math.round(booked / total * 100) : 0 },
      { stage: 'Завершили', count: completed, pct: total ? Math.round(completed / total * 100) : 0 }
    ]
  });
});

router.get('/dashboard/activity', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const activity = db.prepare(`
    SELECT date(created_at) as date,
           COUNT(DISTINCT user_telegram_id) as users,
           COUNT(*) as messages
    FROM messages_log
    WHERE created_at >= datetime('now', '-${days} days')
    GROUP BY date(created_at)
    ORDER BY date
  `).all();
  res.json(activity);
});

// ==================== USERS ====================

router.get('/users', authMiddleware, (req, res) => {
  const users = getAllUsers(req.query);
  res.json(users);
});

router.get('/users/:telegramId', authMiddleware, (req, res) => {
  const user = getUser(parseInt(req.params.telegramId));
  if (!user) return res.status(404).json({ error: 'User not found' });

  const messages = db.prepare(
    'SELECT * FROM messages_log WHERE user_telegram_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(user.telegram_id);

  res.json({ ...user, messages });
});

router.put('/users/:telegramId', authMiddleware, (req, res) => {
  const telegramId = parseInt(req.params.telegramId);
  const allowed = ['booking_status', 'funnel_stage', 'notes', 'warmup_active'];
  const fields = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }
  updateUser(telegramId, fields);
  res.json({ success: true });
});

// ==================== BROADCASTS ====================

router.get('/broadcasts', authMiddleware, (req, res) => {
  const broadcasts = getBroadcasts();
  res.json(broadcasts);
});

router.post('/broadcasts', authMiddleware, (req, res) => {
  const id = createBroadcast(req.body);
  logEvent('broadcast_created', null, { id });
  res.json({ id });
});

router.post('/broadcasts/:id/send', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  updateBroadcast(id, { status: 'sending' });

  // Send async
  sendBroadcast(id).then(result => {
    console.log(`Broadcast ${id} sent:`, result);
  }).catch(err => {
    console.error(`Broadcast ${id} error:`, err);
    updateBroadcast(id, { status: 'error' });
  });

  res.json({ status: 'sending' });
});

router.get('/broadcasts/:id/preview', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return res.status(404).json({ error: 'Not found' });

  const users = getBroadcastUsers(broadcast.segment);
  res.json({ ...broadcast, recipientCount: users.length });
});

// ==================== ANALYTICS ====================

router.get('/analytics/events', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const events = db.prepare(`
    SELECT event_type, COUNT(*) as count, date(created_at) as date
    FROM analytics_events
    WHERE created_at >= datetime('now', '-${days} days')
    GROUP BY event_type, date(created_at)
    ORDER BY date
  `).all();
  res.json(events);
});

router.get('/analytics/sources', authMiddleware, (req, res) => {
  const sources = db.prepare(`
    SELECT source, COUNT(*) as count
    FROM users
    GROUP BY source
    ORDER BY count DESC
  `).all();
  res.json(sources);
});

router.get('/analytics/scenarios', authMiddleware, (req, res) => {
  const scenarios = db.prepare(`
    SELECT scenario, COUNT(*) as count
    FROM users
    WHERE scenario IS NOT NULL
    GROUP BY scenario
    ORDER BY count DESC
  `).all();
  res.json(scenarios);
});

export default router;
