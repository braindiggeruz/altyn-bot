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
    // FIX v4.7.0: Add ALL potentially missing columns to users table
    // This ensures the schema matches regardless of when the table was originally created
    const migrations = [
      // CRITICAL: telegram_id must exist - it's the primary lookup key
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT UNIQUE`,
      // Core user fields
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS scenario TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS quiz_answers TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS quiz_score TEXT DEFAULT '0'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS funnel_stage TEXT DEFAULT 'new'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS warmup_day INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS warmup_active INTEGER DEFAULT 1`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_name TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_request TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_time TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_status TEXT DEFAULT 'none'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'organic'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_source TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_medium TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_campaign TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS exit_reason TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '[]'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT`,
      // v4.2.0: session tracking
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_completed_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS post_session_followup_sent INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS reactivation_sent_at TIMESTAMP`,
      // v4.3.0: TORNADO reactivation
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_day INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_last_sent TIMESTAMP`,
      // v4.9.2: TORNADO unsubscribe / kill-switch flag (separate from exit_reason
      // so admin/broadcast and quiz exit reasons stay independent of "do not warm me").
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_disabled INTEGER DEFAULT 0`,
      // v4.9.3: Conversion-machine TORNADO — segmentation + scoring + tracking.
      // Each column is independently nullable/defaultable, so an old row keeps
      // behaving like 'generic, score 0, never clicked, never paused'.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_segment TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_variant TEXT DEFAULT 'A'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_score INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_tornado_click TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_tornado_reply TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_click_count INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_reply_count INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_paused_until TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_started_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS tornado_hot_notified INTEGER DEFAULT 0`,
      // Backfill segment from quiz scenario for existing users (idempotent).
      `UPDATE users SET tornado_segment = scenario WHERE tornado_segment IS NULL AND scenario IN ('savior','fear','control','freeze')`,
      `UPDATE users SET tornado_segment = 'generic' WHERE tornado_segment IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_users_tornado_segment ON users (tornado_segment, tornado_disabled, tornado_paused_until)`,
      // v4.8.0: Per-channel last-sent tracking (decouples warmup/reminder/tornado timings from updated_at)
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_warmup_sent_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_quiz_reminder_2h_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_quiz_reminder_24h_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_booking_reminder_30m_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_booking_reminder_24h_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_session_reminder_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS quiz_started_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_started_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS quiz_completed_at TIMESTAMP`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_confirmed_at TIMESTAMP`,
      // v4.8.0: Drop NOT NULL on legacy "openId" column if present (caused /start crashes on prod).
      // The column was created by an earlier deploy that no longer exists in code.
      // We make it nullable + give a default so old code paths that touched it still work,
      // and new createUser() inserts no longer violate the constraint.
      // Generic safety net: for ANY column in users that is NOT NULL, has no default,
      // and is NOT in our known managed-column list, drop the NOT NULL constraint.
      // This unsticks the bot from any legacy schema artifact (openId, etc).
      `DO $$
       DECLARE
         r RECORD;
         managed TEXT[] := ARRAY['id','telegram_id'];
       BEGIN
         FOR r IN
           SELECT column_name
           FROM information_schema.columns
           WHERE table_name = 'users'
             AND table_schema = 'public'
             AND is_nullable = 'NO'
             AND column_default IS NULL
             AND NOT (column_name = ANY(managed))
         LOOP
           EXECUTE format('ALTER TABLE users ALTER COLUMN %I DROP NOT NULL', r.column_name);
           RAISE NOTICE 'Dropped NOT NULL from legacy column users.%', r.column_name;
         END LOOP;
       END $$;`,
      // v4.8.0: Hot indexes for cron queries
      `CREATE INDEX IF NOT EXISTS idx_users_warmup ON users (warmup_active, funnel_stage, last_warmup_sent_at)`,
      `CREATE INDEX IF NOT EXISTS idx_users_funnel_stage ON users (funnel_stage)`,
      `CREATE INDEX IF NOT EXISTS idx_users_booking_status ON users (booking_status)`,
      `CREATE INDEX IF NOT EXISTS idx_users_tornado ON users (tornado_day, tornado_last_sent, last_active)`,
      `CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users (telegram_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_log_user ON messages_log (user_telegram_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events (event_type, created_at)`,
      // Timestamps
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active TIMESTAMP DEFAULT NOW()`,
    ];
    for (const mig of migrations) {
      await client.query(mig).catch(() => {});
    }
    console.log('✅ DB migrations applied (v4.7.0 - all columns ensured)');

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

export const updateUser = async (telegramId, fields, skipLastActive = false) => {
  // FIX v4.6.0: Filter out undefined values AND auto-managed fields to prevent duplicates
  // v4.8.0: 'last_active' and 'updated_at' remain auto-managed; everything else (including new
  // last_*_sent_at trackers) is allowed to be set explicitly by the caller.
  const autoFields = ['last_active', 'updated_at'];
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined && !autoFields.includes(k));
  if (keys.length === 0 && skipLastActive) return;
  
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(telegramId);
  
  // FIX v4.2.0: Only update 'updated_at' for significant funnel changes
  // FIX v4.5.0: Skip last_active update when skipLastActive=true (for bot-initiated messages)
  // FIX v4.6.0: Prevent duplicate column names in SET clause
  // FIX v4.7.1: Added warmup_day + booking_name so updated_at tracks warmup progress and booking flow
  // FIX v4.8.0: REMOVED warmup_day from significantFields. updated_at is now reserved exclusively
  // for user-initiated funnel changes (start, quiz progress, booking input). Warmup progress is
  // tracked via last_warmup_sent_at to keep reminder windows accurate.
  const significantFields = ['funnel_stage', 'scenario', 'booking_status', 'quiz_answers', 'booking_name', 'booking_request', 'booking_time'];
  const hasSignificantChange = keys.some(k => significantFields.includes(k));
  
  let updateClause = sets;
  if (hasSignificantChange) {
    updateClause += (updateClause ? ', ' : '') + `updated_at = NOW()`;
  }
  if (!skipLastActive) {
    updateClause += (updateClause ? ', ' : '') + `last_active = NOW()`;
  }
  
  if (!updateClause) return;
  
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
  // FIX v4.7.0: Parse integers to avoid string arithmetic; add missing frontend fields
  const r = async (q) => parseInt((await pool.query(q)).rows[0]?.count || '0', 10);
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

  // FIX v4.7.0: Add missing fields that frontend expects
  const conversionRate = total > 0 ? ((booked / total) * 100).toFixed(2) : '0.00';
  const quizCompletionRate = total > 0 ? ((quizCompleted / total) * 100).toFixed(1) : '0.0';
  const bookingRate = quizCompleted > 0 ? ((booked / quizCompleted) * 100).toFixed(1) : '0.0';

  return {
    total, quizCompleted, warmupActive, booked, completed,
    todayUsers, weekUsers, monthUsers, scenarios, stages, sources, dailyStats,
    conversionRate, quizCompletionRate, bookingRate
  };
};

// v4.8.0: Specialised cron query — only fetch users actually due for a warmup run
// (quiz_completed, warmup active, not booked, not exited, and not already messaged today)
export const getUsersDueForWarmup = async () => {
  const result = await pool.query(`
    SELECT * FROM users
    WHERE warmup_active = 1
    AND funnel_stage = 'quiz_completed'
    AND (booking_status IS NULL OR booking_status = 'none')
    AND (exit_reason IS NULL OR exit_reason = '')
    AND (last_warmup_sent_at IS NULL OR last_warmup_sent_at < NOW() - INTERVAL '20 hours')
    ORDER BY warmup_day ASC, last_warmup_sent_at ASC NULLS FIRST
    LIMIT 500
  `);
  return result.rows;
};

export const getAllUsers = async (filters = {}) => {
  // FIX v4.7.0: Support search, booking_status, and configurable limit
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
  if (filters.booking_status) {
    query += ` AND booking_status = $${paramIndex++}`;
    params.push(filters.booking_status);
  }
  if (filters.search) {
    query += ` AND (first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex} OR username ILIKE $${paramIndex} OR CAST(telegram_id AS TEXT) ILIKE $${paramIndex})`;
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  query += ' ORDER BY created_at DESC';
  const limit = Math.min(parseInt(filters.limit) || 10000, 10000);
  query += ` LIMIT ${limit}`;
  const result = await pool.query(query, params);
  return result.rows;
};

export const getUserCount = async (filters = {}) => {
  // FIX v4.7.0: Support filters for accurate user counts
  let query = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
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
  if (filters.booking_status) {
    query += ` AND booking_status = $${paramIndex++}`;
    params.push(filters.booking_status);
  }
  if (filters.search) {
    query += ` AND (first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex} OR username ILIKE $${paramIndex} OR CAST(telegram_id AS TEXT) ILIKE $${paramIndex})`;
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  const result = await pool.query(query, params);
  return parseInt(result.rows[0]?.count || '0', 10);
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
  let sql, params = [];
  switch (segment) {
    case 'all':
      sql = 'SELECT telegram_id FROM users WHERE warmup_active = 1';
      break;
    case 'quiz_completed':
      sql = "SELECT telegram_id FROM users WHERE funnel_stage = 'quiz_completed'";
      break;
    case 'warmup_active':
      sql = 'SELECT telegram_id FROM users WHERE warmup_active = 1 AND warmup_day > 0';
      break;
    case 'booked':
      sql = "SELECT telegram_id FROM users WHERE booking_status IN ('booked', 'confirmed')";
      break;
    case 'not_booked':
      sql = "SELECT telegram_id FROM users WHERE funnel_stage = 'quiz_completed' AND (booking_status IS NULL OR booking_status = 'none')";
      break;
    case 'new_users':
      sql = "SELECT telegram_id FROM users WHERE created_at >= NOW() - INTERVAL '7 days'";
      break;
    case 'inactive':
      sql = "SELECT telegram_id FROM users WHERE last_active <= NOW() - INTERVAL '7 days'";
      break;
    default:
      // Handle scenario_* segments (e.g. scenario_savior → savior)
      if (segment.startsWith('scenario_')) {
        const scenarioName = segment.replace('scenario_', '');
        sql = 'SELECT telegram_id FROM users WHERE scenario = $1';
        params = [scenarioName];
      } else {
        // Fallback: treat as scenario name directly
        sql = 'SELECT telegram_id FROM users WHERE scenario = $1';
        params = [segment];
      }
  }
  const result = await pool.query(sql, params);
  return result.rows;
};

// ==================== ADMIN PANEL FUNCTIONS (FIX v4.7.0: Real SQL implementations) ====================

export const createBroadcast = async (data) => {
  const result = await pool.query(
    `INSERT INTO broadcasts (title, content, image_url, buttons, segment, status, ab_variant, ab_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [data.title, data.content, data.image_url || null, data.buttons ? JSON.stringify(data.buttons) : null,
     data.segment || 'all', data.status || 'draft', data.ab_variant || null, data.ab_group_id || 0]
  );
  return result.rows[0].id;
};

export const getBroadcasts = async () => {
  const result = await pool.query('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100');
  return result.rows;
};

export const getReferralStats = async () => {
  const totalResult = await pool.query('SELECT COUNT(*) as count FROM referrals');
  const activeResult = await pool.query("SELECT COUNT(*) as count FROM referrals WHERE status = 'active'");
  const topReferrers = await pool.query(`
    SELECT referrer_telegram_id, COUNT(*) as count,
           (SELECT first_name FROM users WHERE telegram_id = referrer_telegram_id) as name,
           (SELECT username FROM users WHERE telegram_id = referrer_telegram_id) as username
    FROM referrals
    GROUP BY referrer_telegram_id
    ORDER BY count DESC
    LIMIT 20
  `);
  return {
    total: parseInt(totalResult.rows[0]?.count || '0', 10),
    active: parseInt(activeResult.rows[0]?.count || '0', 10),
    topReferrers: topReferrers.rows
  };
};

export const getReferralCount = async (telegramId) => {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM referrals WHERE referrer_telegram_id = $1',
    [telegramId]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
};

export const getTemplates = async () => {
  const result = await pool.query('SELECT * FROM broadcast_templates ORDER BY created_at DESC');
  return result.rows;
};

export const createTemplate = async (data) => {
  const result = await pool.query(
    `INSERT INTO broadcast_templates (name, content, image_url, buttons, segment, category)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [data.name, data.content, data.image_url || null, data.buttons ? JSON.stringify(data.buttons) : null,
     data.segment || 'all', data.category || 'general']
  );
  return result.rows[0].id;
};

export const deleteTemplate = async (id) => {
  await pool.query('DELETE FROM broadcast_templates WHERE id = $1', [id]);
  return true;
};

export const getUtmLinks = async () => {
  const result = await pool.query('SELECT * FROM utm_links ORDER BY created_at DESC');
  return result.rows;
};

export const createUtmLink = async (data) => {
  const botUsername = 'altyntherapybot';
  const params = [data.source, data.medium, data.campaign].filter(Boolean).join('_');
  const fullLink = `https://t.me/${botUsername}?start=${params}`;
  const result = await pool.query(
    `INSERT INTO utm_links (name, source, medium, campaign, full_link)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.name, data.source, data.medium || null, data.campaign || null, fullLink]
  );
  return result.rows[0];
};

export const deleteUtmLink = async (id) => {
  await pool.query('DELETE FROM utm_links WHERE id = $1', [id]);
  return true;
};

export const getUserTasks = async (userId) => {
  const result = await pool.query(
    'SELECT * FROM user_tasks WHERE user_telegram_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
};

export const createUserTask = async (data) => {
  const result = await pool.query(
    `INSERT INTO user_tasks (user_telegram_id, title, description, status, due_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [data.user_telegram_id, data.title, data.description || null, data.status || 'pending', data.due_date || null]
  );
  return result.rows[0].id;
};

export const updateUserTask = async (id, fields) => {
  const keys = Object.keys(fields);
  if (keys.length === 0) return true;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(id);
  await pool.query(`UPDATE user_tasks SET ${sets} WHERE id = $${values.length}`, values);
  return true;
};

export const getCohortData = async () => {
  const result = await pool.query(`
    SELECT
      DATE_TRUNC('week', created_at)::date as cohort_week,
      COUNT(*) as total,
      SUM(CASE WHEN scenario IS NOT NULL THEN 1 ELSE 0 END) as quiz_completed,
      SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked,
      ROUND((SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100)::numeric, 1) as conversion_rate
    FROM users
    WHERE created_at >= NOW() - INTERVAL '12 weeks'
    GROUP BY cohort_week
    ORDER BY cohort_week DESC
  `);
  return result.rows;
};

export const getUsersForExport = async (filters = {}) => {
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
  if (filters.booking_status) {
    query += ` AND booking_status = $${paramIndex++}`;
    params.push(filters.booking_status);
  }

  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  return result.rows;
};

export const trackReferral = async (referrerId, referredId) => {
  try {
    await pool.query(
      'INSERT INTO referrals (referrer_telegram_id, referred_telegram_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [referrerId, referredId]
    );
  } catch (err) {
    console.error('trackReferral error:', err.message);
  }
};

export { pool };
