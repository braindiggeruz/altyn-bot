import pg from 'pg';

const { Pool } = pg;

// ==================== DATABASE CONNECTION ====================
// Use DATABASE_URL from Railway PostgreSQL plugin, fallback to individual params
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL && 
        !process.env.DATABASE_URL.includes('localhost') && 
        !process.env.DATABASE_URL.includes('.railway.internal'))
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL pool error:', err.message);
});

// ==================== HELPER: query wrapper ====================
async function query(text, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// Synchronous-style wrapper for backward compatibility
// Returns result.rows for SELECT, result for INSERT/UPDATE/DELETE
function querySync(text, params = []) {
  return pool.query(text, params);
}

// ==================== SCHEMA INITIALIZATION ====================
export async function initDatabase() {
  const client = await pool.connect();
  try {
    // First, add missing columns if they don't exist (migration for v4.2.0)
    // Migration v4.2.0: session tracking fields
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_completed_at TIMESTAMP`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS post_session_followup_sent INTEGER DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reactivation_sent_at TIMESTAMP`).catch(() => {});
    // Migration v4.3.0: TORNADO reactivation fields
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_day INTEGER DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_last_sent TIMESTAMP`).catch(() => {});
    console.log('✅ DB migrations applied (v4.2.0 + v4.3.0)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        scenario TEXT,
        quiz_answers TEXT,
        quiz_score TEXT DEFAULT '0',
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
        session_completed_at TIMESTAMP,
        post_session_followup_sent INTEGER DEFAULT 0,
        reactivation_sent_at TIMESTAMP,
        tornado_day INTEGER DEFAULT 0,
        tornado_last_sent TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        last_active TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages_log (
        id SERIAL PRIMARY KEY,
        user_telegram_id BIGINT,
        direction TEXT CHECK(direction IN ('in', 'out')),
        message_type TEXT,
        content TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS broadcasts (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT,
        buttons TEXT,
        segment TEXT DEFAULT 'all',
        status TEXT DEFAULT 'draft',
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        scheduled_at TIMESTAMP,
        sent_at TIMESTAMP,
        ab_variant TEXT,
        ab_group_id INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        user_telegram_id BIGINT,
        data TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_telegram_id BIGINT NOT NULL,
        referred_telegram_id BIGINT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS broadcast_templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT,
        buttons TEXT,
        segment TEXT DEFAULT 'all',
        category TEXT DEFAULT 'general',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS utm_links (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        medium TEXT,
        campaign TEXT,
        full_link TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        conversions INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_tasks (
        id SERIAL PRIMARY KEY,
        user_telegram_id BIGINT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        due_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database schema initialized and migrated to v4.2.0');
  } catch (err) {
    console.error('Database initialization error:', err.message);
  } finally {
    client.release();
  }
}

// ==================== USER OPERATIONS ====================
export const getUser = async (telegramId) => {
  const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return result.rows[0] || null;
};

export const createUser = async (userData) => {
  const { telegram_id, username, first_name, last_name, source } = userData;
  const existing = await getUser(telegram_id);
  if (existing) return existing;
  const result = await pool.query(
    'INSERT INTO users (telegram_id, username, first_name, last_name, source) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [telegram_id, username, first_name, last_name, source || 'organic']
  );
  return result.rows[0];
};

export const updateUser = async (telegramId, fields) => {
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(telegramId);
  
  // FIX v4.2.0: Only update 'updated_at' for significant funnel changes, not every update
  // This prevents reminder windows from being shifted by admin edits or internal updates
  const significantFields = ['funnel_stage', 'scenario', 'booking_status', 'quiz_answers'];
  const hasSignificantChange = keys.some(k => significantFields.includes(k));
  
  const updateClause = hasSignificantChange 
    ? `${sets}, updated_at = NOW(), last_active = NOW()` 
    : `${sets}, last_active = NOW()`;
  
  await pool.query(
    `UPDATE users SET ${updateClause} WHERE telegram_id = $${values.length}`,
    values
  );
};

export const logMessage = async (telegramId, direction, type, content) => {
  await pool.query(
    'INSERT INTO messages_log (user_telegram_id, direction, message_type, content) VALUES ($1, $2, $3, $4)',
    [telegramId, direction, type, content]
  );
};

export const logEvent = async (type, telegramId, data) => {
  await pool.query(
    'INSERT INTO analytics_events (event_type, user_telegram_id, data) VALUES ($1, $2, $3)',
    [type, telegramId, JSON.stringify(data)]
  );
};

// ==================== STATS ====================
export const getStats = async () => {
  const r = async (q) => (await pool.query(q)).rows[0]?.count || 0;
  const total = await r('SELECT COUNT(*) as count FROM users');
  const quizCompleted = await r("SELECT COUNT(*) as count FROM users WHERE scenario IS NOT NULL");
  const warmupActive = await r("SELECT COUNT(*) as count FROM users WHERE warmup_active = 1 AND warmup_day > 0");
  const booked = await r("SELECT COUNT(*) as count FROM users WHERE booking_status = 'booked'");
  const completed = await r("SELECT COUNT(*) as count FROM users WHERE booking_status = 'completed'");
  const todayUsers = await r("SELECT COUNT(*) as count FROM users WHERE created_at::date = CURRENT_DATE");
  const weekUsers = await r("SELECT COUNT(*) as count FROM users WHERE created_at >= NOW() - INTERVAL '7 days'");
  const monthUsers = await r("SELECT COUNT(*) as count FROM users WHERE created_at >= NOW() - INTERVAL '30 days'");

  const scenarios = (await pool.query("SELECT scenario, COUNT(*) as count FROM users WHERE scenario IS NOT NULL GROUP BY scenario")).rows;
  const stages = (await pool.query("SELECT funnel_stage, COUNT(*) as count FROM users GROUP BY funnel_stage")).rows;
  const sources = (await pool.query("SELECT source, COUNT(*) as count FROM users GROUP BY source ORDER BY count DESC")).rows;

  const dailyStats = (await pool.query(`
    SELECT created_at::date as date, COUNT(*) as count
    FROM users
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY created_at::date
    ORDER BY date
  `)).rows;

  const conversionRate = total > 0 ? ((booked / total) * 100).toFixed(2) : 0;

  return {
    total, quizCompleted, warmupActive, booked, completed,
    todayUsers, weekUsers, monthUsers, scenarios, stages, sources, dailyStats, conversionRate
  };
};

export const getAllUsers = async (filters = {}) => {
  let query = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (filters.scenario) {
    query += ` AND scenario = $${paramIndex++}`;
    params.push(filters.scenario);
  }
  if (filters.funnel_stage) {
    query += ` AND funnel_stage = $${paramIndex++}`;
    params.push(filters.funnel_stage);
  }
  if (filters.warmup_active !== undefined) {
    query += ` AND warmup_active = $${paramIndex++}`;
    params.push(filters.warmup_active);
  }

  query += ' ORDER BY created_at DESC LIMIT 10000';
  const result = await pool.query(query, params);
  return result.rows;
};

export const getUserCount = async () => {
  const result = await pool.query('SELECT COUNT(*) as count FROM users');
  return result.rows[0]?.count || 0;
};

// ==================== BROADCAST OPERATIONS ====================
export const getScheduledBroadcasts = async () => {
  const result = await pool.query(
    "SELECT * FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC"
  );
  return result.rows;
};

export const updateBroadcast = async (id, fields) => {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(id);
  await pool.query(`UPDATE broadcasts SET ${sets} WHERE id = $${values.length}`, values);
};

export const getBroadcastUsers = async (segment) => {
  if (segment === 'all') {
    const result = await pool.query('SELECT telegram_id FROM users WHERE warmup_active = 1');
    return result.rows.map(r => r.telegram_id);
  }
  const result = await pool.query(
    'SELECT telegram_id FROM users WHERE warmup_active = 1 AND scenario = $1',
    [segment]
  );
  return result.rows.map(r => r.telegram_id);
};

// ==================== ADMIN PANEL FUNCTIONS (STUBS) ====================
// These are placeholder functions for admin panel compatibility
// They can be implemented later if needed

export const createBroadcast = async (data) => {
  // Stub: create broadcast
  return { id: Date.now(), ...data };
};

export const getBroadcasts = async () => {
  // Stub: get all broadcasts
  return [];
};

export const getReferralStats = async () => {
  // Stub: get referral statistics
  return { total: 0, active: 0 };
};

export const getReferralCount = async () => {
  // Stub: get referral count
  return 0;
};

export const getTemplates = async () => {
  // Stub: get message templates
  return [];
};

export const createTemplate = async (data) => {
  // Stub: create template
  return { id: Date.now(), ...data };
};

export const deleteTemplate = async (id) => {
  // Stub: delete template
  return true;
};

export const getUtmLinks = async () => {
  // Stub: get UTM links
  return [];
};

export const createUtmLink = async (data) => {
  // Stub: create UTM link
  return { id: Date.now(), ...data };
};

export const deleteUtmLink = async (id) => {
  // Stub: delete UTM link
  return true;
};

export const getUserTasks = async (userId) => {
  // Stub: get user tasks
  return [];
};

export const createUserTask = async (data) => {
  // Stub: create user task
  return { id: Date.now(), ...data };
};

export const updateUserTask = async (id, fields) => {
  // Stub: update user task
  return true;
};

export const getCohortData = async () => {
  // Stub: get cohort data
  return [];
};

export const getUsersForExport = async (filters = {}) => {
  // Stub: get users for export
  return [];
};

export { pool };
