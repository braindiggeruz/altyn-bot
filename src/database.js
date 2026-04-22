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
        due_date TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Safe migrations: add columns if they don't exist
    const migrations = [
      { table: 'users', column: 'referred_by', type: "TEXT DEFAULT ''" },
      { table: 'users', column: 'exit_reason', type: "TEXT DEFAULT ''" },
      { table: 'users', column: 'tags', type: "TEXT DEFAULT '[]'" },
      { table: 'broadcasts', column: 'buttons', type: "TEXT DEFAULT ''" },
      { table: 'broadcasts', column: 'ab_variant', type: "TEXT DEFAULT ''" },
      { table: 'broadcasts', column: 'ab_group_id', type: 'INTEGER DEFAULT 0' }
    ];

    for (const m of migrations) {
      try {
        await client.query(`
          ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.column} ${m.type}
        `);
      } catch (e) {
        // Column might already exist
      }
    }

    // Fix quiz_score column type: must be TEXT to store JSON scores
    try {
      await client.query(`ALTER TABLE users ALTER COLUMN quiz_score TYPE TEXT USING quiz_score::TEXT`);
    } catch (e) {
      // Already TEXT or doesn't exist
    }

    console.log('✅ PostgreSQL database initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ==================== USER FUNCTIONS ====================
export const getUser = async (telegramId) => {
  const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return result.rows[0] || null;
};

export const createUser = async (data) => {
  await pool.query(`
    INSERT INTO users (telegram_id, username, first_name, last_name, source)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username = COALESCE(EXCLUDED.username, users.username),
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      last_name = COALESCE(EXCLUDED.last_name, users.last_name),
      last_active = NOW()
  `, [data.telegram_id, data.username, data.first_name, data.last_name, data.source || 'organic']);
  return getUser(data.telegram_id);
};

export const updateUser = async (telegramId, fields) => {
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(telegramId);
  await pool.query(
    `UPDATE users SET ${sets}, updated_at = NOW(), last_active = NOW() WHERE telegram_id = $${values.length}`,
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

  const quizStarted = await r("SELECT COUNT(*) as count FROM users WHERE funnel_stage NOT IN ('new', 'started')");
  const bookingStarted = await r("SELECT COUNT(*) as count FROM users WHERE funnel_stage IN ('booking','booked','completed')");

  const exitReasons = (await pool.query("SELECT exit_reason, COUNT(*) as count FROM users WHERE exit_reason IS NOT NULL AND exit_reason != '' GROUP BY exit_reason")).rows;

  const totalReferrals = await r("SELECT COUNT(*) as count FROM referrals");
  const referralConversions = await r("SELECT COUNT(*) as count FROM referrals WHERE status = 'converted'");

  const hourlyActivity = (await pool.query(`
    SELECT EXTRACT(HOUR FROM created_at)::INTEGER as hour,
           EXTRACT(DOW FROM created_at)::INTEGER as weekday,
           COUNT(*) as count
    FROM analytics_events
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY hour, weekday
  `)).rows;

  const avgWarmupDay = (await pool.query("SELECT AVG(warmup_day) as avg FROM users WHERE booking_status = 'booked' AND warmup_day > 0")).rows[0];

  return {
    total: parseInt(total), quizCompleted: parseInt(quizCompleted),
    warmupActive: parseInt(warmupActive), booked: parseInt(booked),
    completed: parseInt(completed),
    todayUsers: parseInt(todayUsers), weekUsers: parseInt(weekUsers),
    monthUsers: parseInt(monthUsers),
    scenarios, stages, sources, dailyStats,
    quizStarted: parseInt(quizStarted), bookingStarted: parseInt(bookingStarted),
    exitReasons, totalReferrals: parseInt(totalReferrals),
    referralConversions: parseInt(referralConversions),
    hourlyActivity,
    avgWarmupDayAtConversion: avgWarmupDay?.avg || 0,
    conversionRate: parseInt(total) > 0 ? ((parseInt(booked) / parseInt(total)) * 100).toFixed(1) : 0,
    quizCompletionRate: parseInt(quizStarted) > 0 ? ((parseInt(quizCompleted) / parseInt(quizStarted)) * 100).toFixed(1) : 0,
    bookingRate: parseInt(quizCompleted) > 0 ? ((parseInt(booked) / parseInt(quizCompleted)) * 100).toFixed(1) : 0
  };
};

// ==================== USERS ====================
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
  if (filters.booking_status) {
    query += ` AND booking_status = $${paramIndex++}`;
    params.push(filters.booking_status);
  }
  if (filters.source) {
    query += ` AND source = $${paramIndex++}`;
    params.push(filters.source);
  }
  if (filters.tag) {
    query += ` AND tags LIKE $${paramIndex++}`;
    params.push(`%"${filters.tag}"%`);
  }
  if (filters.has_exit_reason) {
    query += " AND exit_reason IS NOT NULL AND exit_reason != ''";
  }
  if (filters.warmup_active !== undefined) {
    query += ` AND warmup_active = $${paramIndex++}`;
    params.push(filters.warmup_active);
  }
  if (filters.date_from) {
    query += ` AND created_at >= $${paramIndex++}`;
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    query += ` AND created_at <= $${paramIndex++}`;
    params.push(filters.date_to);
  }
  if (filters.search) {
    const s = `%${filters.search}%`;
    query += ` AND (first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex + 1} OR username ILIKE $${paramIndex + 2} OR phone ILIKE $${paramIndex + 3} OR booking_name ILIKE $${paramIndex + 4} OR notes ILIKE $${paramIndex + 5})`;
    params.push(s, s, s, s, s, s);
    paramIndex += 6;
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(parseInt(filters.limit));
  }
  if (filters.offset) {
    query += ` OFFSET $${paramIndex++}`;
    params.push(parseInt(filters.offset));
  }

  const result = await pool.query(query, params);
  return result.rows;
};

export const getUserCount = async (filters = {}) => {
  let query = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
  const params = [];
  let paramIndex = 1;
  if (filters.scenario) { query += ` AND scenario = $${paramIndex++}`; params.push(filters.scenario); }
  if (filters.funnel_stage) { query += ` AND funnel_stage = $${paramIndex++}`; params.push(filters.funnel_stage); }
  if (filters.booking_status) { query += ` AND booking_status = $${paramIndex++}`; params.push(filters.booking_status); }
  const result = await pool.query(query, params);
  return parseInt(result.rows[0].count);
};

// ==================== BROADCASTS ====================
export const createBroadcast = async (data) => {
  const result = await pool.query(
    `INSERT INTO broadcasts (title, content, image_url, buttons, segment, status, scheduled_at, ab_variant, ab_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      data.title, data.content, data.image_url || null,
      data.buttons ? JSON.stringify(data.buttons) : null,
      data.segment || 'all', data.status || 'draft',
      data.scheduled_at || null,
      data.ab_variant || null, data.ab_group_id || 0
    ]
  );
  return result.rows[0].id;
};

export const getBroadcasts = async () => {
  const result = await pool.query('SELECT * FROM broadcasts ORDER BY created_at DESC');
  return result.rows;
};

export const updateBroadcast = async (id, fields) => {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(id);
  await pool.query(`UPDATE broadcasts SET ${sets} WHERE id = $${values.length}`, values);
};

export const getBroadcastUsers = async (segment) => {
  let q;
  let params = [];
  if (segment === 'all') q = 'SELECT telegram_id FROM users';
  else if (segment === 'quiz_completed') q = "SELECT telegram_id FROM users WHERE scenario IS NOT NULL";
  else if (segment === 'warmup_active') q = "SELECT telegram_id FROM users WHERE warmup_active = 1";
  else if (segment === 'booked') q = "SELECT telegram_id FROM users WHERE booking_status = 'booked'";
  else if (segment === 'not_booked') q = "SELECT telegram_id FROM users WHERE booking_status = 'none' AND scenario IS NOT NULL";
  else if (segment === 'new_users') q = "SELECT telegram_id FROM users WHERE funnel_stage IN ('new','started')";
  else if (segment === 'inactive') q = "SELECT telegram_id FROM users WHERE warmup_active = 0 AND booking_status = 'none'";
  else if (segment === 'referrers') q = "SELECT DISTINCT referrer_telegram_id as telegram_id FROM referrals";
  else if (segment && segment.startsWith('scenario_')) {
    const sc = segment.replace('scenario_', '');
    q = "SELECT telegram_id FROM users WHERE scenario = $1";
    params = [sc];
  }
  else if (segment && segment.startsWith('tag_')) {
    const tag = segment.replace('tag_', '');
    q = "SELECT telegram_id FROM users WHERE tags LIKE $1";
    params = [`%"${tag}"%`];
  }
  else if (segment && segment.startsWith('exit_')) {
    q = "SELECT telegram_id FROM users WHERE exit_reason = $1";
    params = [segment];
  }
  else q = 'SELECT telegram_id FROM users';

  const result = await pool.query(q, params);
  return result.rows;
};

export const getScheduledBroadcasts = async () => {
  const result = await pool.query("SELECT * FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= NOW()");
  return result.rows;
};

// ==================== REFERRALS ====================
export const trackReferral = async (referrerId, referredId) => {
  try {
    await pool.query(
      'INSERT INTO referrals (referrer_telegram_id, referred_telegram_id) VALUES ($1, $2)',
      [referrerId, referredId]
    );
  } catch (e) {
    // Duplicate or other error
  }
};

export const getReferralCount = async (telegramId) => {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM referrals WHERE referrer_telegram_id = $1',
    [telegramId]
  );
  return parseInt(result.rows[0]?.count) || 0;
};

export const getReferralStats = async () => {
  const result = await pool.query(`
    SELECT r.referrer_telegram_id, u.first_name, u.username,
           COUNT(*) as total_referrals,
           SUM(CASE WHEN r.status = 'converted' THEN 1 ELSE 0 END) as conversions
    FROM referrals r
    LEFT JOIN users u ON u.telegram_id = r.referrer_telegram_id
    GROUP BY r.referrer_telegram_id, u.first_name, u.username
    ORDER BY total_referrals DESC
  `);
  return result.rows;
};

// ==================== TEMPLATES ====================
export const getTemplates = async () => {
  const result = await pool.query('SELECT * FROM broadcast_templates ORDER BY created_at DESC');
  return result.rows;
};

export const createTemplate = async (data) => {
  const result = await pool.query(
    'INSERT INTO broadcast_templates (name, content, image_url, buttons, segment, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [data.name, data.content, data.image_url || null, data.buttons || null, data.segment || 'all', data.category || 'general']
  );
  return result.rows[0].id;
};

export const deleteTemplate = async (id) => {
  await pool.query('DELETE FROM broadcast_templates WHERE id = $1', [id]);
};

// ==================== UTM LINKS ====================
export const getUtmLinks = async () => {
  const result = await pool.query('SELECT * FROM utm_links ORDER BY created_at DESC');
  return result.rows;
};

export const createUtmLink = async (data) => {
  const fullLink = `https://t.me/altyntherapybot?start=${data.source}_${data.medium || 'link'}_${data.campaign || 'default'}`;
  const result = await pool.query(
    'INSERT INTO utm_links (name, source, medium, campaign, full_link) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [data.name, data.source, data.medium, data.campaign, fullLink]
  );
  return { id: result.rows[0].id, full_link: fullLink };
};

export const deleteUtmLink = async (id) => {
  await pool.query('DELETE FROM utm_links WHERE id = $1', [id]);
};

// ==================== USER TASKS (CRM) ====================
export const getUserTasks = async (telegramId) => {
  const result = await pool.query(
    'SELECT * FROM user_tasks WHERE user_telegram_id = $1 ORDER BY created_at DESC',
    [telegramId]
  );
  return result.rows;
};

export const createUserTask = async (data) => {
  const result = await pool.query(
    'INSERT INTO user_tasks (user_telegram_id, title, description, due_date) VALUES ($1, $2, $3, $4) RETURNING id',
    [data.user_telegram_id, data.title, data.description || null, data.due_date || null]
  );
  return result.rows[0].id;
};

export const updateUserTask = async (id, fields) => {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(id);
  await pool.query(`UPDATE user_tasks SET ${sets} WHERE id = $${values.length}`, values);
};

// ==================== COHORT ANALYSIS ====================
export const getCohortData = async () => {
  const result = await pool.query(`
    SELECT
      TO_CHAR(created_at, 'IYYY-IW') as cohort_week,
      COUNT(*) as total,
      SUM(CASE WHEN scenario IS NOT NULL THEN 1 ELSE 0 END) as quiz_completed,
      SUM(CASE WHEN booking_status = 'booked' THEN 1 ELSE 0 END) as booked,
      SUM(CASE WHEN booking_status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM users
    WHERE created_at >= NOW() - INTERVAL '90 days'
    GROUP BY cohort_week
    ORDER BY cohort_week
  `);
  return result.rows;
};

// ==================== CSV EXPORT ====================
export const getUsersForExport = async (filters = {}) => {
  return getAllUsers({ ...filters, limit: 10000 });
};

// ==================== POOL EXPORT (for direct queries in admin-api) ====================
export { pool };
export default pool;
