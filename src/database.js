import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'altyn.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
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
    segment TEXT DEFAULT 'all',
    status TEXT DEFAULT 'draft',
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    scheduled_at TEXT,
    sent_at TEXT,
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
`);

// Helper functions
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
  const keys = Object.keys(fields);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  db.prepare(`UPDATE users SET ${sets}, updated_at = datetime('now') WHERE telegram_id = ?`).run(...values, telegramId);
};

export const logMessage = (telegramId, direction, type, content) => {
  db.prepare('INSERT INTO messages_log (user_telegram_id, direction, message_type, content) VALUES (?, ?, ?, ?)')
    .run(telegramId, direction, type, content);
};

export const logEvent = (type, telegramId, data) => {
  db.prepare('INSERT INTO analytics_events (event_type, user_telegram_id, data) VALUES (?, ?, ?)')
    .run(type, telegramId, JSON.stringify(data));
};

export const getStats = () => {
  const total = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const quizCompleted = db.prepare("SELECT COUNT(*) as count FROM users WHERE scenario IS NOT NULL").get().count;
  const warmupActive = db.prepare("SELECT COUNT(*) as count FROM users WHERE warmup_active = 1 AND warmup_day > 0").get().count;
  const booked = db.prepare("SELECT COUNT(*) as count FROM users WHERE booking_status = 'booked'").get().count;
  const completed = db.prepare("SELECT COUNT(*) as count FROM users WHERE booking_status = 'completed'").get().count;
  const todayUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE date(created_at) = date('now')").get().count;
  const weekUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE created_at >= datetime('now', '-7 days')").get().count;

  const scenarios = db.prepare("SELECT scenario, COUNT(*) as count FROM users WHERE scenario IS NOT NULL GROUP BY scenario").all();
  const stages = db.prepare("SELECT funnel_stage, COUNT(*) as count FROM users GROUP BY funnel_stage").all();

  const dailyStats = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as count
    FROM users
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY date
  `).all();

  return { total, quizCompleted, warmupActive, booked, completed, todayUsers, weekUsers, scenarios, stages, dailyStats };
};

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
  if (filters.search) {
    query += ' AND (first_name LIKE ? OR last_name LIKE ? OR username LIKE ? OR phone LIKE ?)';
    const s = `%${filters.search}%`;
    params.push(s, s, s, s);
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return db.prepare(query).all(...params);
};

export const createBroadcast = (data) => {
  const stmt = db.prepare('INSERT INTO broadcasts (title, content, image_url, segment, status, scheduled_at) VALUES (?, ?, ?, ?, ?, ?)');
  const result = stmt.run(data.title, data.content, data.image_url || null, data.segment || 'all', data.status || 'draft', data.scheduled_at || null);
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
  if (segment.startsWith('scenario_')) {
    const sc = segment.replace('scenario_', '');
    return db.prepare("SELECT telegram_id FROM users WHERE scenario = ?").all(sc);
  }
  return db.prepare('SELECT telegram_id FROM users').all();
};

export default db;
