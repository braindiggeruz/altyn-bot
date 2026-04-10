import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'altyn.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== SCHEMA ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    scenario TEXT,
    quiz_answers TEXT,
    quiz_score INTEGER DEFAULT 0,
    funnel_stage TEXT DEFAULT 'new',
    warmup_day INTEGER DEFAULT 0,
    warmup_active INTEGER DEFAULT 1,
    booking_name TEXT,
    booking_request TEXT,
    booking_time TEXT,
    booking_status TEXT DEFAULT 'none',
    source TEXT DEFAULT 'organic',
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    referred_by TEXT,
    exit_reason TEXT,
    tags TEXT DEFAULT '[]',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_active TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_telegram_id INTEGER,
    direction TEXT CHECK(direction IN ('in', 'out')),
    message_type TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    image_url TEXT,
    buttons TEXT,
    segment TEXT DEFAULT 'all',
    status TEXT DEFAULT 'draft',
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    scheduled_at TEXT,
    sent_at TEXT,
    ab_variant TEXT,
    ab_group_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    user_telegram_id INTEGER,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_telegram_id INTEGER NOT NULL,
    referred_telegram_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS broadcast_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    image_url TEXT,
    buttons TEXT,
    segment TEXT DEFAULT 'all',
    category TEXT DEFAULT 'general',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS utm_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    medium TEXT,
    campaign TEXT,
    full_link TEXT NOT NULL,
    clicks INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_telegram_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    due_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ==================== MIGRATIONS (safe ALTER TABLE) ====================
const safeAddColumn = (table, column, type, dflt) => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${dflt !== undefined ? ` DEFAULT ${dflt}` : ''}`);
    }
  } catch(e) {}
};

safeAddColumn('users', 'referred_by', 'TEXT', "''");
safeAddColumn('users', 'exit_reason', 'TEXT', "''");
safeAddColumn('users', 'tags', 'TEXT', "'[]'");
safeAddColumn('broadcasts', 'buttons', 'TEXT', "''");
safeAddColumn('broadcasts', 'ab_variant', 'TEXT', "''");
safeAddColumn('broadcasts', 'ab_group_id', 'INTEGER', '0');

// ==================== USER FUNCTIONS ====================
export const getUser = (telegramId) => {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
};

export const createUser = (data) => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(data.telegram_id, data.username, data.first_name, data.last_name, data.source || 'organic');
  return getUser(data.telegram_id);
};

export const updateUser = (telegramId, fields) => {
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  db.prepare(`UPDATE users SET ${sets}, updated_at = datetime('now'), last_active = datetime('now') WHERE telegram_id = ?`).run(...values, telegramId);
};

export const logMessage = (telegramId, direction, type, content) => {
  db.prepare('INSERT INTO messages_log (user_telegram_id, direction, message_type, content) VALUES (?, ?, ?, ?)')
    .run(telegramId, direction, type, content);
};

export const logEvent = (type, telegramId, data) => {
  db.prepare('INSERT INTO analytics_events (event_type, user_telegram_id, data) VALUES (?, ?, ?)')
    .run(type, telegramId, JSON.stringify(data));
};

// ==================== STATS ====================
export const getStats = () => {
  const total = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const quizCompleted = db.prepare("SELECT COUNT(*) as count FROM users WHERE scenario IS NOT NULL").get().count;
  const warmupActive = db.prepare("SELECT COUNT(*) as count FROM users WHERE warmup_active = 1 AND warmup_day > 0").get().count;
  const booked = db.prepare("SELECT COUNT(*) as count FROM users WHERE booking_status = 'booked'").get().count;
  const completed = db.prepare("SELECT COUNT(*) as count FROM users WHERE booking_status = 'completed'").get().count;
  const todayUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE date(created_at) = date('now')").get().count;
  const weekUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE created_at >= datetime('now', '-7 days')").get().count;
  const monthUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE created_at >= datetime('now', '-30 days')").get().count;

  const scenarios = db.prepare("SELECT scenario, COUNT(*) as count FROM users WHERE scenario IS NOT NULL GROUP BY scenario").all();
  const stages = db.prepare("SELECT funnel_stage, COUNT(*) as count FROM users GROUP BY funnel_stage").all();
  const sources = db.prepare("SELECT source, COUNT(*) as count FROM users GROUP BY source ORDER BY count DESC").all();

  const dailyStats = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as count
    FROM users
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY date
  `).all();

  // Conversion rates
  const quizStarted = db.prepare("SELECT COUNT(*) as count FROM users WHERE funnel_stage != 'new' AND funnel_stage != 'started'").get().count;
  const bookingStarted = db.prepare("SELECT COUNT(*) as count FROM users WHERE funnel_stage IN ('booking','booked','completed')").get().count;

  // Exit survey stats
  const exitReasons = db.prepare("SELECT exit_reason, COUNT(*) as count FROM users WHERE exit_reason IS NOT NULL AND exit_reason != '' GROUP BY exit_reason").all();

  // Referral stats
  const totalReferrals = db.prepare("SELECT COUNT(*) as count FROM referrals").get().count;
  const referralConversions = db.prepare("SELECT COUNT(*) as count FROM referrals WHERE status = 'converted'").get().count;

  // Hourly activity heatmap (last 30 days)
  const hourlyActivity = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, 
           CAST(strftime('%w', created_at) AS INTEGER) as weekday,
           COUNT(*) as count
    FROM analytics_events
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY hour, weekday
  `).all();

  // Average warmup day at conversion
  const avgWarmupDay = db.prepare("SELECT AVG(warmup_day) as avg FROM users WHERE booking_status = 'booked' AND warmup_day > 0").get();

  return {
    total, quizCompleted, warmupActive, booked, completed,
    todayUsers, weekUsers, monthUsers,
    scenarios, stages, sources, dailyStats,
    quizStarted, bookingStarted,
    exitReasons, totalReferrals, referralConversions,
    hourlyActivity,
    avgWarmupDayAtConversion: avgWarmupDay?.avg || 0,
    conversionRate: total > 0 ? ((booked / total) * 100).toFixed(1) : 0,
    quizCompletionRate: quizStarted > 0 ? ((quizCompleted / quizStarted) * 100).toFixed(1) : 0,
    bookingRate: quizCompleted > 0 ? ((booked / quizCompleted) * 100).toFixed(1) : 0
  };
};

// ==================== USERS ====================
export const getAllUsers = (filters = {}) => {
  let query = 'SELECT * FROM users WHERE 1=1';
  const params = [];

  if (filters.scenario) {
    query += ' AND scenario = ?';
    params.push(filters.scenario);
  }
  if (filters.funnel_stage) {
    query += ' AND funnel_stage = ?';
    params.push(filters.funnel_stage);
  }
  if (filters.booking_status) {
    query += ' AND booking_status = ?';
    params.push(filters.booking_status);
  }
  if (filters.source) {
    query += ' AND source = ?';
    params.push(filters.source);
  }
  if (filters.tag) {
    query += " AND tags LIKE ?";
    params.push(`%"${filters.tag}"%`);
  }
  if (filters.has_exit_reason) {
    query += " AND exit_reason IS NOT NULL AND exit_reason != ''";
  }
  if (filters.warmup_active !== undefined) {
    query += ' AND warmup_active = ?';
    params.push(filters.warmup_active);
  }
  if (filters.date_from) {
    query += ' AND created_at >= ?';
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    query += ' AND created_at <= ?';
    params.push(filters.date_to);
  }
  if (filters.search) {
    query += ' AND (first_name LIKE ? OR last_name LIKE ? OR username LIKE ? OR phone LIKE ? OR booking_name LIKE ? OR notes LIKE ?)';
    const s = `%${filters.search}%`;
    params.push(s, s, s, s, s, s);
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(parseInt(filters.limit));
  }
  if (filters.offset) {
    query += ' OFFSET ?';
    params.push(parseInt(filters.offset));
  }

  return db.prepare(query).all(...params);
};

export const getUserCount = (filters = {}) => {
  let query = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
  const params = [];
  if (filters.scenario) { query += ' AND scenario = ?'; params.push(filters.scenario); }
  if (filters.funnel_stage) { query += ' AND funnel_stage = ?'; params.push(filters.funnel_stage); }
  if (filters.booking_status) { query += ' AND booking_status = ?'; params.push(filters.booking_status); }
  return db.prepare(query).get(...params).count;
};

// ==================== BROADCASTS ====================
export const createBroadcast = (data) => {
  const stmt = db.prepare('INSERT INTO broadcasts (title, content, image_url, buttons, segment, status, scheduled_at, ab_variant, ab_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const result = stmt.run(
    data.title, data.content, data.image_url || null,
    data.buttons ? JSON.stringify(data.buttons) : null,
    data.segment || 'all', data.status || 'draft',
    data.scheduled_at || null,
    data.ab_variant || null, data.ab_group_id || 0
  );
  return result.lastInsertRowid;
};

export const getBroadcasts = () => {
  return db.prepare('SELECT * FROM broadcasts ORDER BY created_at DESC').all();
};

export const updateBroadcast = (id, fields) => {
  const keys = Object.keys(fields);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  db.prepare(`UPDATE broadcasts SET ${sets} WHERE id = ?`).run(...values, id);
};

export const getBroadcastUsers = (segment) => {
  if (segment === 'all') return db.prepare('SELECT telegram_id FROM users').all();
  if (segment === 'quiz_completed') return db.prepare("SELECT telegram_id FROM users WHERE scenario IS NOT NULL").all();
  if (segment === 'warmup_active') return db.prepare("SELECT telegram_id FROM users WHERE warmup_active = 1").all();
  if (segment === 'booked') return db.prepare("SELECT telegram_id FROM users WHERE booking_status = 'booked'").all();
  if (segment === 'not_booked') return db.prepare("SELECT telegram_id FROM users WHERE booking_status = 'none' AND scenario IS NOT NULL").all();
  if (segment === 'new_users') return db.prepare("SELECT telegram_id FROM users WHERE funnel_stage IN ('new','started')").all();
  if (segment === 'inactive') return db.prepare("SELECT telegram_id FROM users WHERE warmup_active = 0 AND booking_status = 'none'").all();
  if (segment === 'referrers') return db.prepare("SELECT DISTINCT referrer_telegram_id as telegram_id FROM referrals").all();
  if (segment.startsWith('scenario_')) {
    const sc = segment.replace('scenario_', '');
    return db.prepare("SELECT telegram_id FROM users WHERE scenario = ?").all(sc);
  }
  if (segment.startsWith('tag_')) {
    const tag = segment.replace('tag_', '');
    return db.prepare("SELECT telegram_id FROM users WHERE tags LIKE ?").all(`%"${tag}"%`);
  }
  if (segment.startsWith('exit_')) {
    return db.prepare("SELECT telegram_id FROM users WHERE exit_reason = ?").all(segment);
  }
  return db.prepare('SELECT telegram_id FROM users').all();
};

export const getScheduledBroadcasts = () => {
  return db.prepare("SELECT * FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= datetime('now')").all();
};

// ==================== REFERRALS ====================
export const trackReferral = (referrerId, referredId) => {
  try {
    db.prepare('INSERT INTO referrals (referrer_telegram_id, referred_telegram_id) VALUES (?, ?)').run(referrerId, referredId);
  } catch(e) {}
};

export const getReferralCount = (telegramId) => {
  return db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_telegram_id = ?').get(telegramId)?.count || 0;
};

export const getReferralStats = () => {
  return db.prepare(`
    SELECT r.referrer_telegram_id, u.first_name, u.username, 
           COUNT(*) as total_referrals,
           SUM(CASE WHEN r.status = 'converted' THEN 1 ELSE 0 END) as conversions
    FROM referrals r
    LEFT JOIN users u ON u.telegram_id = r.referrer_telegram_id
    GROUP BY r.referrer_telegram_id
    ORDER BY total_referrals DESC
  `).all();
};

// ==================== TEMPLATES ====================
export const getTemplates = () => {
  return db.prepare('SELECT * FROM broadcast_templates ORDER BY created_at DESC').all();
};

export const createTemplate = (data) => {
  const stmt = db.prepare('INSERT INTO broadcast_templates (name, content, image_url, buttons, segment, category) VALUES (?, ?, ?, ?, ?, ?)');
  return stmt.run(data.name, data.content, data.image_url || null, data.buttons || null, data.segment || 'all', data.category || 'general').lastInsertRowid;
};

export const deleteTemplate = (id) => {
  db.prepare('DELETE FROM broadcast_templates WHERE id = ?').run(id);
};

// ==================== UTM LINKS ====================
export const getUtmLinks = () => {
  return db.prepare('SELECT * FROM utm_links ORDER BY created_at DESC').all();
};

export const createUtmLink = (data) => {
  const fullLink = `https://t.me/altyntherapybot?start=${data.source}_${data.medium || 'link'}_${data.campaign || 'default'}`;
  const stmt = db.prepare('INSERT INTO utm_links (name, source, medium, campaign, full_link) VALUES (?, ?, ?, ?, ?)');
  return { id: stmt.run(data.name, data.source, data.medium, data.campaign, fullLink).lastInsertRowid, full_link: fullLink };
};

export const deleteUtmLink = (id) => {
  db.prepare('DELETE FROM utm_links WHERE id = ?').run(id);
};

// ==================== USER TASKS (CRM) ====================
export const getUserTasks = (telegramId) => {
  return db.prepare('SELECT * FROM user_tasks WHERE user_telegram_id = ? ORDER BY created_at DESC').all(telegramId);
};

export const createUserTask = (data) => {
  const stmt = db.prepare('INSERT INTO user_tasks (user_telegram_id, title, description, due_date) VALUES (?, ?, ?, ?)');
  return stmt.run(data.user_telegram_id, data.title, data.description || null, data.due_date || null).lastInsertRowid;
};

export const updateUserTask = (id, fields) => {
  const keys = Object.keys(fields);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  db.prepare(`UPDATE user_tasks SET ${sets} WHERE id = ?`).run(...values, id);
};

// ==================== COHORT ANALYSIS ====================
export const getCohortData = () => {
  return db.prepare(`
    SELECT 
      strftime('%Y-%W', created_at) as cohort_week,
      COUNT(*) as total,
      SUM(CASE WHEN scenario IS NOT NULL THEN 1 ELSE 0 END) as quiz_completed,
      SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked,
      SUM(CASE WHEN booking_status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM users
    WHERE created_at >= datetime('now', '-90 days')
    GROUP BY cohort_week
    ORDER BY cohort_week
  `).all();
};

// ==================== CSV EXPORT ====================
export const getUsersForExport = (filters = {}) => {
  return getAllUsers({ ...filters, limit: 10000 });
};

export default db;
