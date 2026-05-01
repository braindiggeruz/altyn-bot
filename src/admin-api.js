import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import {
  getStats, getAllUsers, getUser, updateUser, getUserCount,
  createBroadcast, getBroadcasts, updateBroadcast, getBroadcastUsers,
  getScheduledBroadcasts,
  logEvent,
  getReferralStats, getReferralCount,
  getTemplates, createTemplate, deleteTemplate,
  getUtmLinks, createUtmLink, deleteUtmLink,
  getUserTasks, createUserTask, updateUserTask,
  getCohortData, getUsersForExport,
  pool
} from './database.js';
import { sendBroadcast, sendBroadcastToChat } from './bot.js';

const router = express.Router();
// FIX v4.7.0: Use stable fallback secret instead of random (tokens survive restarts)
const JWT_SECRET = process.env.JWT_SECRET || 'altyn_jwt_stable_secret_2024_production_key';

// Apply security headers
router.use(helmet({ contentSecurityPolicy: false }));

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

router.post('/auth/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const adminResult = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    const admin = adminResult.rows[0];

    if (!admin) {
      const countResult = await pool.query('SELECT COUNT(*) as count FROM admin_users');
      const count = parseInt(countResult.rows[0].count);
      if (count === 0 && username && password) {
        const hash = bcrypt.hashSync(password, 10);
        await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', [username, hash]);
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
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/auth/me', authMiddleware, (req, res) => {
  res.json(req.admin);
});

// ==================== DASHBOARD ====================

router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    console.error('Dashboard error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load dashboard', detail: err.message });
  }
});

router.get('/dashboard/funnel', authMiddleware, async (req, res) => {
  try {
    const r = async (q) => parseInt((await pool.query(q)).rows[0]?.c || 0);
    const total = await r('SELECT COUNT(*) as c FROM users');
    const started = await r("SELECT COUNT(*) as c FROM users WHERE funnel_stage != 'new'");
    const quizStarted = await r("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('quiz','quiz_completed','booking','booked','completed')");
    const quizCompleted = await r("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('quiz_completed','booking','booked','completed')");
    const bookingStarted = await r("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('booking','booked','completed')");
    const booked = await r("SELECT COUNT(*) as c FROM users WHERE funnel_stage IN ('booked','completed')");
    const completed = await r("SELECT COUNT(*) as c FROM users WHERE funnel_stage = 'completed'");

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
  } catch (err) {
    console.error('Funnel error:', err.message);
    res.status(500).json({ error: 'Failed to load funnel' });
  }
});

router.get('/dashboard/activity', authMiddleware, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const result = await pool.query(`
      SELECT created_at::date as date,
             COUNT(DISTINCT user_telegram_id) as users,
             COUNT(*) as messages
      FROM messages_log
      WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY created_at::date
      ORDER BY date
    `, [days.toString()]);
    res.json(result.rows);
  } catch (err) {
    console.error('Activity error:', err.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.get('/dashboard/heatmap', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT EXTRACT(HOUR FROM created_at)::INTEGER as hour,
             EXTRACT(DOW FROM created_at)::INTEGER as weekday,
             COUNT(*) as count
      FROM analytics_events
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY hour, weekday
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Heatmap error:', err.message);
    res.status(500).json({ error: 'Failed to load heatmap' });
  }
});

// ==================== USERS ====================

router.get('/users', authMiddleware, async (req, res) => {
  try {
    const users = await getAllUsers(req.query);
    const total = await getUserCount(req.query);
    res.json({ users, total });
  } catch (err) {
    console.error('Users list error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

router.get('/users/:telegramId', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(parseInt(req.params.telegramId));
    if (!user) return res.status(404).json({ error: 'User not found' });

    const messagesResult = await pool.query(
      'SELECT * FROM messages_log WHERE user_telegram_id = $1 ORDER BY created_at DESC LIMIT 100',
      [user.telegram_id]
    );

    const tasks = await getUserTasks(user.telegram_id);
    const referralCount = await getReferralCount(user.telegram_id);

    res.json({ ...user, messages: messagesResult.rows, tasks, referralCount });
  } catch (err) {
    console.error('User detail error:', err.message);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

router.put('/users/:telegramId', authMiddleware, async (req, res) => {
  try {
    const telegramId = parseInt(req.params.telegramId);
    const allowed = ['booking_status', 'funnel_stage', 'notes', 'warmup_active', 'tags', 'phone'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    await updateUser(telegramId, fields);
    await logEvent('admin_user_update', telegramId, { fields: Object.keys(fields) });
    res.json({ success: true });
  } catch (err) {
    console.error('User update error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// User tags
router.post('/users/:telegramId/tags', authMiddleware, async (req, res) => {
  try {
    const telegramId = parseInt(req.params.telegramId);
    const user = await getUser(telegramId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let tags = [];
    try { tags = JSON.parse(user.tags || '[]'); } catch(e) {}
    const newTag = req.body.tag;
    if (newTag && !tags.includes(newTag)) {
      tags.push(newTag);
      await updateUser(telegramId, { tags: JSON.stringify(tags) });
    }
    res.json({ tags });
  } catch (err) {
    console.error('Tags error:', err.message);
    res.status(500).json({ error: 'Failed to update tags' });
  }
});

router.delete('/users/:telegramId/tags/:tag', authMiddleware, async (req, res) => {
  try {
    const telegramId = parseInt(req.params.telegramId);
    const user = await getUser(telegramId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let tags = [];
    try { tags = JSON.parse(user.tags || '[]'); } catch(e) {}
    tags = tags.filter(t => t !== req.params.tag);
    await updateUser(telegramId, { tags: JSON.stringify(tags) });
    res.json({ tags });
  } catch (err) {
    console.error('Tags delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// User tasks (CRM)
router.post('/users/:telegramId/tasks', authMiddleware, async (req, res) => {
  try {
    const id = await createUserTask({
      user_telegram_id: parseInt(req.params.telegramId),
      ...req.body
    });
    res.json({ id });
  } catch (err) {
    console.error('Task create error:', err.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

router.put('/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const allowed = ['title', 'description', 'status', 'due_date', 'priority'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    await updateUserTask(parseInt(req.params.id), fields);
    res.json({ success: true });
  } catch (err) {
    console.error('Task update error:', err.message);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ==================== CSV EXPORT ====================

router.get('/users/export/csv', authMiddleware, async (req, res) => {
  try {
    const users = await getUsersForExport(req.query);

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
    res.send('\uFEFF' + csvContent);
  } catch (err) {
    console.error('CSV export error:', err.message);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// ==================== BROADCASTS ====================

router.get('/broadcasts', authMiddleware, async (req, res) => {
  try {
    const broadcasts = await getBroadcasts();
    res.json(broadcasts);
  } catch (err) {
    console.error('Broadcasts error:', err.message);
    res.status(500).json({ error: 'Failed to load broadcasts' });
  }
});

router.post('/broadcasts', authMiddleware, async (req, res) => {
  try {
    const id = await createBroadcast(req.body);
    await logEvent('broadcast_created', null, { id, title: req.body.title });
    res.json({ id });
  } catch (err) {
    console.error('Broadcast create error:', err.message);
    res.status(500).json({ error: 'Failed to create broadcast' });
  }
});

router.post('/broadcasts/:id/send', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });

    // Pre-flight: broadcast exists?
    const r = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [id]);
    const broadcast = r.rows[0];
    if (!broadcast) return res.status(404).json({ error: 'broadcast_not_found' });
    if (broadcast.status === 'sending') {
      return res.status(409).json({ error: 'already_sending', message: 'Эта рассылка уже отправляется' });
    }

    // Pre-flight: recipients?
    const users = await getBroadcastUsers(broadcast.segment);
    if (users.length === 0) {
      console.warn(`⚠️ /broadcasts/${id}/send → 0 recipients for segment "${broadcast.segment}"`);
      return res.status(400).json({
        error: 'no_recipients',
        message: 'Список получателей пуст для выбранного сегмента',
        segment: broadcast.segment,
        recipients: 0
      });
    }

    await updateBroadcast(id, { status: 'sending' });

    // Background dispatch — admin gets immediate sync response with the count.
    sendBroadcast(id).then(result => {
      console.log(`Broadcast ${id} done:`, JSON.stringify(result));
      logEvent('broadcast_dispatch_complete', null, { id, ...result });
    }).catch(err => {
      console.error(`Broadcast ${id} dispatcher error:`, err.message, err.stack);
      updateBroadcast(id, { status: 'error' });
      logEvent('broadcast_dispatch_error', null, { id, error: err.message });
    });

    res.json({
      status: 'sending',
      recipients: users.length,
      segment: broadcast.segment,
      has_image: !!broadcast.image_url
    });
  } catch (err) {
    console.error('Broadcast send error:', err.message, err.stack);
    res.status(500).json({ error: 'failed_to_send_broadcast', message: err.message });
  }
});

// 🧪 TEST broadcast: send to ONE specific chat_id (admin's own Telegram)
// before hitting the whole list. Returns sync result so admin sees image
// validation / parse_mode / keyboard issues immediately.
router.post('/broadcasts/:id/test', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' });

    let chatId = req.body && (req.body.chat_id ?? req.body.chatId);
    if (!chatId && process.env.OWNER_TELEGRAM_ID) chatId = process.env.OWNER_TELEGRAM_ID;
    if (!chatId) {
      return res.status(400).json({ error: 'chat_id_required', message: 'Укажите chat_id или установите OWNER_TELEGRAM_ID на сервере' });
    }
    chatId = parseInt(chatId);
    if (Number.isNaN(chatId)) return res.status(400).json({ error: 'invalid_chat_id' });

    const result = await sendBroadcastToChat(id, chatId);
    if (!result.ok) {
      return res.status(400).json({ error: result.error, image_warning: result.image_warning, chat_id: chatId });
    }
    await logEvent('broadcast_test_sent', null, { id, chat_id: chatId, image_warning: result.image_warning });
    res.json({ ok: true, chat_id: chatId, image_url_used: result.image_url_used, image_warning: result.image_warning });
  } catch (err) {
    console.error('Broadcast test error:', err.message, err.stack);
    res.status(500).json({ error: 'test_failed', message: err.message });
  }
});

router.post('/broadcasts/:id/schedule', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { scheduled_at } = req.body;
    await updateBroadcast(id, { status: 'scheduled', scheduled_at });
    await logEvent('broadcast_scheduled', null, { id, scheduled_at });
    res.json({ status: 'scheduled' });
  } catch (err) {
    console.error('Broadcast schedule error:', err.message);
    res.status(500).json({ error: 'Failed to schedule broadcast' });
  }
});

router.delete('/broadcasts/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query("DELETE FROM broadcasts WHERE id = $1 AND status = 'draft'", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Broadcast delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

router.get('/broadcasts/:id/preview', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [id]);
    const broadcast = result.rows[0];
    if (!broadcast) return res.status(404).json({ error: 'Not found' });

    const users = await getBroadcastUsers(broadcast.segment);
    res.json({ ...broadcast, recipientCount: users.length });
  } catch (err) {
    console.error('Broadcast preview error:', err.message);
    res.status(500).json({ error: 'Failed to preview broadcast' });
  }
});

// A/B Testing
router.post('/broadcasts/ab-test', authMiddleware, async (req, res) => {
  try {
    const { title, variants, segment } = req.body;
    const groupId = Date.now();
    const ids = [];

    for (let i = 0; i < variants.length; i++) {
      const id = await createBroadcast({
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

    await logEvent('ab_test_created', null, { groupId, variants: ids.length });
    res.json({ groupId, broadcastIds: ids });
  } catch (err) {
    console.error('AB test error:', err.message);
    res.status(500).json({ error: 'Failed to create A/B test' });
  }
});

router.get('/broadcasts/ab-results/:groupId', authMiddleware, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const result = await pool.query('SELECT * FROM broadcasts WHERE ab_group_id = $1', [groupId]);
    res.json(result.rows);
  } catch (err) {
    console.error('AB results error:', err.message);
    res.status(500).json({ error: 'Failed to load A/B results' });
  }
});

// Segment count
router.get('/broadcasts/segment-count/:segment', authMiddleware, async (req, res) => {
  try {
    const users = await getBroadcastUsers(req.params.segment);
    res.json({ count: users.length });
  } catch (err) {
    console.error('Segment count error:', err.message);
    res.status(500).json({ error: 'Failed to count segment' });
  }
});

// ==================== TEMPLATES ====================

router.get('/templates', authMiddleware, async (req, res) => {
  try {
    const templates = await getTemplates();
    res.json(templates);
  } catch (err) {
    console.error('Templates error:', err.message);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

router.post('/templates', authMiddleware, async (req, res) => {
  try {
    const id = await createTemplate(req.body);
    res.json({ id });
  } catch (err) {
    console.error('Template create error:', err.message);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.delete('/templates/:id', authMiddleware, async (req, res) => {
  try {
    await deleteTemplate(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error('Template delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// ==================== UTM LINKS ====================

router.get('/utm-links', authMiddleware, async (req, res) => {
  try {
    const links = await getUtmLinks();
    res.json(links);
  } catch (err) {
    console.error('UTM links error:', err.message);
    res.status(500).json({ error: 'Failed to load UTM links' });
  }
});

router.post('/utm-links', authMiddleware, async (req, res) => {
  try {
    const result = await createUtmLink(req.body);
    res.json(result);
  } catch (err) {
    console.error('UTM link create error:', err.message);
    res.status(500).json({ error: 'Failed to create UTM link' });
  }
});

router.delete('/utm-links/:id', authMiddleware, async (req, res) => {
  try {
    await deleteUtmLink(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error('UTM link delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete UTM link' });
  }
});

// ==================== ANALYTICS ====================

router.get('/analytics/events', authMiddleware, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const result = await pool.query(`
      SELECT event_type, COUNT(*) as count, created_at::date as date
      FROM analytics_events
      WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY event_type, created_at::date
      ORDER BY date
    `, [days.toString()]);
    res.json(result.rows);
  } catch (err) {
    console.error('Analytics events error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

router.get('/analytics/sources', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT source, COUNT(*) as count,
             SUM(CASE WHEN scenario IS NOT NULL THEN 1 ELSE 0 END) as quiz_completed,
             SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked
      FROM users
      GROUP BY source
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Analytics sources error:', err.message);
    res.status(500).json({ error: 'Failed to load sources' });
  }
});

router.get('/analytics/scenarios', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT scenario, COUNT(*) as count,
             SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked,
             AVG(warmup_day) as avg_warmup_day
      FROM users
      WHERE scenario IS NOT NULL
      GROUP BY scenario
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Analytics scenarios error:', err.message);
    res.status(500).json({ error: 'Failed to load scenarios' });
  }
});

router.get('/analytics/cohorts', authMiddleware, async (req, res) => {
  try {
    const cohorts = await getCohortData();
    res.json(cohorts);
  } catch (err) {
    console.error('Cohorts error:', err.message);
    res.status(500).json({ error: 'Failed to load cohorts' });
  }
});

router.get('/analytics/referrals', authMiddleware, async (req, res) => {
  try {
    const stats = await getReferralStats();
    res.json(stats);
  } catch (err) {
    console.error('Referrals error:', err.message);
    res.status(500).json({ error: 'Failed to load referrals' });
  }
});

router.get('/analytics/exit-reasons', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT exit_reason, COUNT(*) as count
      FROM users
      WHERE exit_reason IS NOT NULL AND exit_reason != ''
      GROUP BY exit_reason
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Exit reasons error:', err.message);
    res.status(500).json({ error: 'Failed to load exit reasons' });
  }
});

router.get('/analytics/warmup-effectiveness', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT warmup_day, COUNT(*) as total,
             SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as converted
      FROM users
      WHERE warmup_day > 0
      GROUP BY warmup_day
      ORDER BY warmup_day
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Warmup effectiveness error:', err.message);
    res.status(500).json({ error: 'Failed to load warmup data' });
  }
});

router.get('/analytics/conversion-by-source', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT source,
             COUNT(*) as total,
             SUM(CASE WHEN scenario IS NOT NULL THEN 1 ELSE 0 END) as quiz_done,
             SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked,
             ROUND(CAST(SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) AS FLOAT) / NULLIF(COUNT(*), 0) * 100, 1) as conversion_rate
      FROM users
      GROUP BY source
      ORDER BY conversion_rate DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Conversion by source error:', err.message);
    res.status(500).json({ error: 'Failed to load conversion data' });
  }
});

// Alias: /api/login -> /api/auth/login for convenience
router.post('/login', (req, res, next) => {
  req.url = '/auth/login';
  router.handle(req, res, next);
});

export default router;
