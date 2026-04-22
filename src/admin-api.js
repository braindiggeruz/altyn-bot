import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  getStats, getAllUsers, getUser, updateUser, getUserCount,
  createBroadcast, getBroadcasts, updateBroadcast, getBroadcastUsers,
  getScheduledBroadcasts,
  logEvent,
  getReferralStats, getReferralCount,
  getTemplates, createTemplate, deleteTemplate,
  getUtmLinks, createUtmLink, deleteUtmLink,
  getUserTasks, createUserTask, updateUserTask,
  getCohortData, getUsersForExport
} from './database.js';
import { sendBroadcast } from './bot.js';
import db from './database.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'altyn-admin-secret-2024';

// Simple in-memory rate limiter for login attempts (max 10 per 15 min per IP)
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 10) return false;
  recent.push(now);
  loginAttempts.set(ip, recent);
  return true;
}

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
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);

  if (!admin) {
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

router.get('/dashboard/heatmap', authMiddleware, (req, res) => {
  const heatmap = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
           CAST(strftime('%w', created_at) AS INTEGER) as weekday,
           COUNT(*) as count
    FROM analytics_events
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY hour, weekday
  `).all();
  res.json(heatmap);
});

// ==================== USERS ====================

router.get('/users', authMiddleware, (req, res) => {
  const users = getAllUsers(req.query);
  const total = getUserCount(req.query);
  res.json({ users, total });
});

router.get('/users/:telegramId', authMiddleware, (req, res) => {
  const user = getUser(parseInt(req.params.telegramId));
  if (!user) return res.status(404).json({ error: 'User not found' });

  const messages = db.prepare(
    'SELECT * FROM messages_log WHERE user_telegram_id = ? ORDER BY created_at DESC LIMIT 100'
  ).all(user.telegram_id);

  const tasks = getUserTasks(user.telegram_id);
  const referralCount = getReferralCount(user.telegram_id);

  res.json({ ...user, messages, tasks, referralCount });
});

router.put('/users/:telegramId', authMiddleware, (req, res) => {
  const telegramId = parseInt(req.params.telegramId);
  const allowed = ['booking_status', 'funnel_stage', 'notes', 'warmup_active', 'tags', 'phone'];
  const fields = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }
  updateUser(telegramId, fields);
  logEvent('admin_user_update', telegramId, { fields: Object.keys(fields) });
  res.json({ success: true });
});

// User tags
router.post('/users/:telegramId/tags', authMiddleware, (req, res) => {
  const telegramId = parseInt(req.params.telegramId);
  const user = getUser(telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let tags = [];
  try { tags = JSON.parse(user.tags || '[]'); } catch(e) {}
  const newTag = req.body.tag;
  if (newTag && !tags.includes(newTag)) {
    tags.push(newTag);
    updateUser(telegramId, { tags: JSON.stringify(tags) });
  }
  res.json({ tags });
});

router.delete('/users/:telegramId/tags/:tag', authMiddleware, (req, res) => {
  const telegramId = parseInt(req.params.telegramId);
  const user = getUser(telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let tags = [];
  try { tags = JSON.parse(user.tags || '[]'); } catch(e) {}
  tags = tags.filter(t => t !== req.params.tag);
  updateUser(telegramId, { tags: JSON.stringify(tags) });
  res.json({ tags });
});

// User tasks (CRM)
router.post('/users/:telegramId/tasks', authMiddleware, (req, res) => {
  const id = createUserTask({
    user_telegram_id: parseInt(req.params.telegramId),
    ...req.body
  });
  res.json({ id });
});

router.put('/tasks/:id', authMiddleware, (req, res) => {
  updateUserTask(parseInt(req.params.id), req.body);
  res.json({ success: true });
});

// ==================== CSV EXPORT ====================

router.get('/users/export/csv', authMiddleware, (req, res) => {
  const users = getUsersForExport(req.query);
  
  const headers = ['ID', 'Telegram ID', 'Username', 'Имя', 'Фамилия', 'Телефон', 'Сценарий', 'Этап воронки', 'Статус записи', 'Имя для записи', 'Запрос', 'Время записи', 'Источник', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'Причина отказа', 'Теги', 'Заметки', 'Дата регистрации'];
  
  const rows = users.map(u => [
    u.id, u.telegram_id, u.username || '', u.first_name || '', u.last_name || '',
    u.phone || '', u.scenario || '', u.funnel_stage, u.booking_status,
    u.booking_name || '', u.booking_request || '', u.booking_time || '',
    u.source || '', u.utm_source || '', u.utm_medium || '', u.utm_campaign || '',
    u.exit_reason || '', u.tags || '', u.notes || '', u.created_at
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=altyn_users_export.csv');
  res.send('\uFEFF' + csvContent); // BOM for Excel
});

// ==================== BROADCASTS ====================

router.get('/broadcasts', authMiddleware, (req, res) => {
  const broadcasts = getBroadcasts();
  res.json(broadcasts);
});

router.post('/broadcasts', authMiddleware, (req, res) => {
  const id = createBroadcast(req.body);
  logEvent('broadcast_created', null, { id, title: req.body.title });
  res.json({ id });
});

router.post('/broadcasts/:id/send', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  updateBroadcast(id, { status: 'sending' });

  sendBroadcast(id).then(result => {
    console.log(`Broadcast ${id} sent:`, result);
  }).catch(err => {
    console.error(`Broadcast ${id} error:`, err);
    updateBroadcast(id, { status: 'error' });
  });

  res.json({ status: 'sending' });
});

router.post('/broadcasts/:id/schedule', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const { scheduled_at } = req.body;
  updateBroadcast(id, { status: 'scheduled', scheduled_at });
  logEvent('broadcast_scheduled', null, { id, scheduled_at });
  res.json({ status: 'scheduled' });
});

router.delete('/broadcasts/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('DELETE FROM broadcasts WHERE id = ? AND status = "draft"').run(id);
  res.json({ success: true });
});

router.get('/broadcasts/:id/preview', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return res.status(404).json({ error: 'Not found' });

  const users = getBroadcastUsers(broadcast.segment);
  res.json({ ...broadcast, recipientCount: users.length });
});

// A/B Testing
router.post('/broadcasts/ab-test', authMiddleware, (req, res) => {
  const { title, variants, segment } = req.body;
  // variants = [{ content, image_url }, { content, image_url }]
  const groupId = Date.now();
  const ids = [];

  for (let i = 0; i < variants.length; i++) {
    const id = createBroadcast({
      title: `${title} (Вариант ${String.fromCharCode(65 + i)})`,
      content: variants[i].content,
      image_url: variants[i].image_url,
      buttons: variants[i].buttons,
      segment,
      status: 'draft',
      ab_variant: String.fromCharCode(65 + i),
      ab_group_id: groupId
    });
    ids.push(id);
  }

  logEvent('ab_test_created', null, { groupId, variants: ids.length });
  res.json({ groupId, broadcastIds: ids });
});

router.get('/broadcasts/ab-results/:groupId', authMiddleware, (req, res) => {
  const groupId = parseInt(req.params.groupId);
  const variants = db.prepare('SELECT * FROM broadcasts WHERE ab_group_id = ?').all(groupId);
  res.json(variants);
});

// Segment count
router.get('/broadcasts/segment-count/:segment', authMiddleware, (req, res) => {
  const users = getBroadcastUsers(req.params.segment);
  res.json({ count: users.length });
});

// ==================== TEMPLATES ====================

router.get('/templates', authMiddleware, (req, res) => {
  const templates = getTemplates();
  res.json(templates);
});

router.post('/templates', authMiddleware, (req, res) => {
  const id = createTemplate(req.body);
  res.json({ id });
});

router.delete('/templates/:id', authMiddleware, (req, res) => {
  deleteTemplate(parseInt(req.params.id));
  res.json({ success: true });
});

// ==================== UTM LINKS ====================

router.get('/utm-links', authMiddleware, (req, res) => {
  const links = getUtmLinks();
  res.json(links);
});

router.post('/utm-links', authMiddleware, (req, res) => {
  const result = createUtmLink(req.body);
  res.json(result);
});

router.delete('/utm-links/:id', authMiddleware, (req, res) => {
  deleteUtmLink(parseInt(req.params.id));
  res.json({ success: true });
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
    SELECT source, COUNT(*) as count,
           SUM(CASE WHEN scenario IS NOT NULL THEN 1 ELSE 0 END) as quiz_completed,
           SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked
    FROM users
    GROUP BY source
    ORDER BY count DESC
  `).all();
  res.json(sources);
});

router.get('/analytics/scenarios', authMiddleware, (req, res) => {
  const scenarios = db.prepare(`
    SELECT scenario, COUNT(*) as count,
           SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked,
           AVG(warmup_day) as avg_warmup_day
    FROM users
    WHERE scenario IS NOT NULL
    GROUP BY scenario
    ORDER BY count DESC
  `).all();
  res.json(scenarios);
});

router.get('/analytics/cohorts', authMiddleware, (req, res) => {
  const cohorts = getCohortData();
  res.json(cohorts);
});

router.get('/analytics/referrals', authMiddleware, (req, res) => {
  const stats = getReferralStats();
  res.json(stats);
});

router.get('/analytics/exit-reasons', authMiddleware, (req, res) => {
  const reasons = db.prepare(`
    SELECT exit_reason, COUNT(*) as count
    FROM users
    WHERE exit_reason IS NOT NULL AND exit_reason != ''
    GROUP BY exit_reason
    ORDER BY count DESC
  `).all();
  res.json(reasons);
});

router.get('/analytics/warmup-effectiveness', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT warmup_day, COUNT(*) as total,
           SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as converted
    FROM users
    WHERE warmup_day > 0
    GROUP BY warmup_day
    ORDER BY warmup_day
  `).all();
  res.json(data);
});

router.get('/analytics/conversion-by-source', authMiddleware, (req, res) => {
  const data = db.prepare(`
    SELECT source, 
           COUNT(*) as total,
           SUM(CASE WHEN scenario IS NOT NULL THEN 1 ELSE 0 END) as quiz_done,
           SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked,
           ROUND(CAST(SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100, 1) as conversion_rate
    FROM users
    GROUP BY source
    ORDER BY conversion_rate DESC
  `).all();
  res.json(data);
});

export default router;
