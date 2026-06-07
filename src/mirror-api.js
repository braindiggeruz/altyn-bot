// ============================================================
// ALTYN Mirror — backend ingest + admin API
// ============================================================
// Phase 2.2 deliverable.
//
// - POST /api/mirror/event  → Bearer-protected ingest from Cloudflare Pages
//                             Function /api/mirror-event (server-to-server).
// - GET  /api/admin/mirror/sessions[/:id]
// - GET  /api/admin/mirror/stats           → admin views (JWT-protected via
//                                             adminRouter mount in index.js).
//
// Hard rules (enforced here):
//   * Feature flag MIRROR_INGEST_ENABLED — when not 'true', endpoint replies
//     { ok:true, disabled:true } and writes NOTHING to DB.
//   * Token compared with timingSafeEqual; no token printed; no .env values.
//   * No raw IP / user-agent persisted. We only store hex SHA-256 truncated
//     to 16 chars so admins can group events without re-identifying.
//   * No users-table writes here. Telegram linking happens in bot am_ branch.
//   * Allowed event names whitelist; everything else → 400.
//   * Idempotency: insert by event_id with ON CONFLICT DO NOTHING.
//   * Status state-machine for mirror_sessions is monotonic — never
//     downgrades (completed > owner_intent/bot_intent > started > linked).
//   * In-memory per-IP rate limit: 60 req/min default, configurable via
//     MIRROR_INGEST_RATE_PER_MIN.
//
// This module exports:
//   - mirrorIngestRouter   (mount at /api/mirror BEFORE adminRouter)
//   - registerMirrorAdminRoutes(router, authMiddleware)
//   - linkMirrorSessionToTelegram(amToken, telegramId)   ← used by bot.js
// ============================================================

import express from 'express';
import crypto from 'crypto';
import { pool } from './database.js';

const ALLOWED_EVENTS = new Set([
  'mirror_session_started',
  'mirror_completed',
  'owner_direct_intent',
  'telegram_bot_intent',
]);

// Monotonic ranking. A session's status never goes "backwards".
const STATUS_RANK = {
  started:      1,
  linked:       2,
  bot_intent:   3,
  owner_intent: 4,
  completed:    5,
};

const EVENT_TO_STATUS = {
  mirror_session_started: 'started',
  mirror_completed:       'completed',
  owner_direct_intent:    'owner_intent',
  telegram_bot_intent:    'bot_intent',
};

// ============================================================
// Helpers
// ============================================================

function hashAnon(value) {
  if (!value || typeof value !== 'string') return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function safeString(v, maxLen) {
  if (v === null || v === undefined) return null;
  let s = String(v);
  // Strip control chars + zero-width tricks; keep printable & unicode letters.
  s = s.replace(/[\u0000-\u001F\u007F\u200B\u200C\u200D]/g, '');
  s = s.trim();
  if (!s) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function safeBool(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return null;
}

function safeTimestamp(v) {
  if (!v) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Accept either seconds or ms epoch.
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function tokenIsValid(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Per-IP rate limiter. Cheap, in-memory, sliding 60s window.
const _bucket = new Map();
function rateLimited(ip, max) {
  const now = Date.now();
  const arr = (_bucket.get(ip) || []).filter(t => now - t < 60 * 1000);
  if (arr.length >= max) {
    _bucket.set(ip, arr);
    return true;
  }
  arr.push(now);
  _bucket.set(ip, arr);
  return false;
}

// Safe JSONB encode. Reject if not a plain object/array of primitives.
function safeJson(v, maxSize = 4096) {
  if (v === null || v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    if (s.length > maxSize) return null;
    return s;
  } catch {
    return null;
  }
}

// ============================================================
// Validation
// ============================================================
// Returns { ok:true, clean } | { ok:false, error }
function validatePayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'bad_json' };
  }
  const eventName = safeString(raw.event_name, 40);
  if (!eventName || !ALLOWED_EVENTS.has(eventName)) {
    return { ok: false, error: 'invalid_event_name' };
  }
  const sessionId = safeString(raw.session_id, 80);
  if (!sessionId) return { ok: false, error: 'missing_session_id' };

  const eventId = safeString(raw.event_id, 120);
  if (!eventId) return { ok: false, error: 'missing_event_id' };

  const clean = {
    event_name: eventName,
    session_id: sessionId,
    event_id: eventId,
    am_token: safeString(raw.am_token, 80),
    result_type: safeString(raw.result_type, 32),
    secondary_result: safeString(raw.secondary_result, 32),
    answers: safeJson(raw.answers, 4096),
    lang: safeString(raw.lang, 8),
    source: safeString(raw.source, 60),
    utm_source: safeString(raw.utm_source, 60),
    utm_campaign: safeString(raw.utm_campaign, 60),
    utm_content: safeString(raw.utm_content, 60),
    utm_term: safeString(raw.utm_term, 60),
    fbclid_present: safeBool(raw.fbclid_present),
    page_path: safeString(raw.page_path, 200),
    landing_path: safeString(raw.landing_path, 200),
    from: safeString(raw.from, 40),
    prepared_message_present: safeBool(raw.prepared_message_present),
    timestamp:
      safeTimestamp(raw.timestamp) ||
      safeTimestamp(raw.created_at) ||
      new Date().toISOString(),
  };
  return { ok: true, clean };
}

// ============================================================
// DB write — session upsert + event insert.
// Returns { duplicate: bool } so callers/tests can distinguish.
// ============================================================
async function persistEvent(clean, hashes) {
  const eventTimestamp = clean.timestamp;
  const newStatus = EVENT_TO_STATUS[clean.event_name];

  // Per-event timestamp column on mirror_sessions.
  const sessionTimestampCol = {
    mirror_session_started: 'started_at',
    mirror_completed:       'completed_at',
    owner_direct_intent:    'owner_direct_clicked_at',
    telegram_bot_intent:    'bot_intent_clicked_at',
  }[clean.event_name];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Upsert mirror_sessions (without overwriting stronger status / older ts).
    // We do not store IP / UA on sessions — only on events (hashed).
    await client.query(
      `
      INSERT INTO mirror_sessions (
        session_id, am_token, result_type, secondary_result,
        lang, source, utm_source, utm_campaign, utm_content, utm_term,
        fbclid_present, landing_path, first_page_path, last_page_path,
        status, ${sessionTimestampCol}, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $13,
        $14, $15, NOW(), NOW()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        am_token         = COALESCE(mirror_sessions.am_token, EXCLUDED.am_token),
        result_type      = COALESCE(EXCLUDED.result_type, mirror_sessions.result_type),
        secondary_result = COALESCE(EXCLUDED.secondary_result, mirror_sessions.secondary_result),
        lang             = COALESCE(mirror_sessions.lang, EXCLUDED.lang),
        source           = COALESCE(mirror_sessions.source, EXCLUDED.source),
        utm_source       = COALESCE(mirror_sessions.utm_source, EXCLUDED.utm_source),
        utm_campaign     = COALESCE(mirror_sessions.utm_campaign, EXCLUDED.utm_campaign),
        utm_content      = COALESCE(mirror_sessions.utm_content, EXCLUDED.utm_content),
        utm_term         = COALESCE(mirror_sessions.utm_term, EXCLUDED.utm_term),
        fbclid_present   = COALESCE(mirror_sessions.fbclid_present, EXCLUDED.fbclid_present),
        landing_path     = COALESCE(mirror_sessions.landing_path, EXCLUDED.landing_path),
        last_page_path   = COALESCE(EXCLUDED.last_page_path, mirror_sessions.last_page_path),
        ${sessionTimestampCol} = COALESCE(mirror_sessions.${sessionTimestampCol}, EXCLUDED.${sessionTimestampCol}),
        status = CASE
          WHEN COALESCE((SELECT rank FROM (VALUES
            ('started',1),('linked',2),('bot_intent',3),('owner_intent',4),('completed',5)
          ) AS r(s,rank) WHERE r.s = EXCLUDED.status), 0)
          > COALESCE((SELECT rank FROM (VALUES
            ('started',1),('linked',2),('bot_intent',3),('owner_intent',4),('completed',5)
          ) AS r(s,rank) WHERE r.s = mirror_sessions.status), 0)
          THEN EXCLUDED.status
          ELSE mirror_sessions.status
        END,
        updated_at = NOW()
      `,
      [
        clean.session_id,
        clean.am_token,
        clean.result_type,
        clean.secondary_result,
        clean.lang,
        clean.source,
        clean.utm_source,
        clean.utm_campaign,
        clean.utm_content,
        clean.utm_term,
        clean.fbclid_present,
        clean.landing_path,
        clean.page_path,
        newStatus,
        eventTimestamp,
      ]
    );

    // 2) Insert mirror_events (idempotent on event_id).
    const evRes = await client.query(
      `
      INSERT INTO mirror_events (
        session_id, event_id, event_name,
        result_type, secondary_result, answers,
        lang, source, utm_source, utm_campaign, utm_content, utm_term,
        fbclid_present, page_path, landing_path,
        from_cta, prepared_message_present,
        user_agent_hash, ip_hash,
        created_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15,
        $16, $17,
        $18, $19,
        $20
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
      `,
      [
        clean.session_id,
        clean.event_id,
        clean.event_name,
        clean.result_type,
        clean.secondary_result,
        clean.answers,
        clean.lang,
        clean.source,
        clean.utm_source,
        clean.utm_campaign,
        clean.utm_content,
        clean.utm_term,
        clean.fbclid_present,
        clean.page_path,
        clean.landing_path,
        clean.from,
        clean.prepared_message_present,
        hashes.ua_hash,
        hashes.ip_hash,
        eventTimestamp,
      ]
    );

    await client.query('COMMIT');
    return { duplicate: evRes.rowCount === 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
// Ingest router (Bearer auth)
// ============================================================
export const mirrorIngestRouter = express.Router();

mirrorIngestRouter.post('/event', async (req, res) => {
  // 1) Feature flag — when not 'true', endpoint is a no-op.
  const enabled = String(process.env.MIRROR_INGEST_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) {
    // We DO still validate the auth header to avoid leaking the on/off state
    // to unauthenticated callers, but we never read/write the DB.
    const tokenEnv = process.env.MIRROR_INGEST_TOKEN || '';
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!tokenIsValid(provided, tokenEnv)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return res.json({ ok: true, disabled: true });
  }

  // 2) Auth.
  const tokenEnv = process.env.MIRROR_INGEST_TOKEN || '';
  if (!tokenEnv) {
    // Misconfiguration — token must be set when ingest is enabled.
    return res.status(503).json({ ok: false, error: 'token_not_configured' });
  }
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tokenIsValid(provided, tokenEnv)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // 3) Rate limit (per IP).
  const ip = req.get('cf-connecting-ip') || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ipKey = String(ip).split(',')[0].trim();
  const maxPerMin = parseInt(process.env.MIRROR_INGEST_RATE_PER_MIN || '60', 10);
  if (rateLimited(ipKey, maxPerMin)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  // 4) Validate payload.
  const v = validatePayload(req.body);
  if (!v.ok) {
    return res.status(400).json({ ok: false, error: v.error });
  }

  // 5) Persist.
  const hashes = {
    ua_hash: hashAnon(req.get('user-agent') || ''),
    ip_hash: hashAnon(ipKey),
  };
  try {
    const { duplicate } = await persistEvent(v.clean, hashes);
    return res.json({ ok: true, duplicate });
  } catch (err) {
    console.error('[mirror-ingest] persist error:', err.message);
    if (global.__addError) global.__addError('mirror-ingest', err.message, err.stack);
    return res.status(500).json({ ok: false, error: 'persist_failed' });
  }
});

// ============================================================
// Bot helper — link am_<token> to telegram_id, set status='linked'
// (only if current status is < linked).
// ============================================================
export async function linkMirrorSessionToTelegram(amTokenOrSessionId, telegramId) {
  if (!amTokenOrSessionId || !telegramId) return { ok: false, error: 'bad_args' };
  // Caller may pass either the raw am_<id> token OR the session_id (without
  // 'am_' prefix). Try am_token first, then session_id as fallback.
  try {
    const r1 = await pool.query(
      `
      UPDATE mirror_sessions
         SET telegram_id = $2,
             linked_at   = COALESCE(linked_at, NOW()),
             status = CASE
               WHEN COALESCE((SELECT rank FROM (VALUES
                 ('started',1),('linked',2),('bot_intent',3),('owner_intent',4),('completed',5)
               ) AS r(s,rank) WHERE r.s = status), 0) < 2
               THEN 'linked' ELSE status
             END,
             updated_at = NOW()
       WHERE am_token = $1 OR session_id = $1
       RETURNING session_id, status
      `,
      [amTokenOrSessionId, telegramId]
    );
    if (r1.rowCount > 0) return { ok: true, session_id: r1.rows[0].session_id };
    return { ok: false, error: 'not_found' };
  } catch (err) {
    console.error('[mirror-link] error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============================================================
// Admin routes (JWT) — registerMirrorAdminRoutes(router, authMiddleware)
// ============================================================
export function registerMirrorAdminRoutes(router, authMiddleware) {
  // List mirror sessions with optional filters.
  router.get('/admin/mirror/sessions', authMiddleware, async (req, res) => {
    try {
      const limit  = Math.min(Math.max(parseInt(req.query.limit  || '100', 10) || 100, 1), 500);
      const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
      const status = safeString(req.query.status, 20);
      const result_type = safeString(req.query.result_type, 32);
      const source = safeString(req.query.source, 60);
      const linked = req.query.linked; // 'yes' | 'no' | undefined

      const where = [];
      const params = [];
      let i = 1;
      if (status)      { where.push(`status = $${i++}`); params.push(status); }
      if (result_type) { where.push(`result_type = $${i++}`); params.push(result_type); }
      if (source)      { where.push(`source = $${i++}`); params.push(source); }
      if (linked === 'yes') where.push(`telegram_id IS NOT NULL`);
      if (linked === 'no')  where.push(`telegram_id IS NULL`);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = await pool.query(
        `
        SELECT s.session_id, s.am_token, s.telegram_id, s.status,
               s.result_type, s.secondary_result, s.source,
               s.utm_source, s.utm_campaign, s.utm_content, s.utm_term,
               s.lang, s.landing_path, s.last_page_path,
               s.started_at, s.completed_at,
               s.owner_direct_clicked_at, s.bot_intent_clicked_at,
               s.linked_at, s.created_at, s.updated_at,
               (SELECT COUNT(*)::int FROM mirror_events e WHERE e.session_id = s.session_id) AS event_count
          FROM mirror_sessions s
          ${whereSql}
         ORDER BY s.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
        `,
        params
      );
      const total = await pool.query(
        `SELECT COUNT(*)::int AS c FROM mirror_sessions ${whereSql}`,
        params
      );
      res.json({ total: total.rows[0].c, limit, offset, rows: rows.rows });
    } catch (err) {
      console.error('Mirror sessions list error:', err.message);
      res.status(500).json({ error: 'failed_to_load_mirror_sessions' });
    }
  });

  // Single mirror session + its events.
  router.get('/admin/mirror/sessions/:session_id', authMiddleware, async (req, res) => {
    try {
      const sid = safeString(req.params.session_id, 80);
      if (!sid) return res.status(400).json({ error: 'bad_session_id' });

      const sess = await pool.query(`SELECT * FROM mirror_sessions WHERE session_id = $1`, [sid]);
      if (sess.rowCount === 0) return res.status(404).json({ error: 'not_found' });

      const ev = await pool.query(
        `SELECT id, event_id, event_name, result_type, secondary_result,
                from_cta, page_path, landing_path,
                source, utm_source, utm_campaign, utm_content, utm_term,
                fbclid_present, prepared_message_present, lang,
                created_at
           FROM mirror_events
          WHERE session_id = $1
          ORDER BY created_at ASC
          LIMIT 500`,
        [sid]
      );
      res.json({ session: sess.rows[0], events: ev.rows });
    } catch (err) {
      console.error('Mirror session detail error:', err.message);
      res.status(500).json({ error: 'failed_to_load_mirror_session' });
    }
  });

  // Aggregate stats — small dashboard payload.
  router.get('/admin/mirror/stats', authMiddleware, async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);

      const overall = await pool.query(
        `SELECT
           COUNT(*)::int                                       AS sessions,
           COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed,
           COUNT(*) FILTER (WHERE owner_direct_clicked_at IS NOT NULL)::int AS owner_intent,
           COUNT(*) FILTER (WHERE bot_intent_clicked_at IS NOT NULL)::int   AS bot_intent,
           COUNT(*) FILTER (WHERE telegram_id IS NOT NULL)::int             AS linked_telegram
         FROM mirror_sessions
         WHERE created_at > NOW() - ($1 || ' days')::interval`,
        [String(days)]
      );

      const byStatus = await pool.query(
        `SELECT status, COUNT(*)::int AS c
           FROM mirror_sessions
          WHERE created_at > NOW() - ($1 || ' days')::interval
          GROUP BY status ORDER BY c DESC`,
        [String(days)]
      );

      const byResult = await pool.query(
        `SELECT COALESCE(result_type,'-') AS result_type, COUNT(*)::int AS c
           FROM mirror_sessions
          WHERE created_at > NOW() - ($1 || ' days')::interval
          GROUP BY 1 ORDER BY c DESC`,
        [String(days)]
      );

      const bySource = await pool.query(
        `SELECT COALESCE(source,'direct') AS source,
                COALESCE(utm_campaign,'-') AS utm_campaign,
                COUNT(*)::int AS c
           FROM mirror_sessions
          WHERE created_at > NOW() - ($1 || ' days')::interval
          GROUP BY 1,2 ORDER BY c DESC LIMIT 50`,
        [String(days)]
      );

      const recentEvents = await pool.query(
        `SELECT event_name, COUNT(*)::int AS c
           FROM mirror_events
          WHERE created_at > NOW() - ($1 || ' days')::interval
          GROUP BY 1 ORDER BY c DESC`,
        [String(days)]
      );

      res.json({
        days,
        overall: overall.rows[0],
        by_status: byStatus.rows,
        by_result_type: byResult.rows,
        by_source: bySource.rows,
        events_breakdown: recentEvents.rows,
        ingest_enabled: String(process.env.MIRROR_INGEST_ENABLED || '').toLowerCase() === 'true',
      });
    } catch (err) {
      console.error('Mirror stats error:', err.message);
      res.status(500).json({ error: 'failed_to_load_mirror_stats' });
    }
  });
}

// Exposed for tests.
export const __testing__ = {
  validatePayload,
  STATUS_RANK,
  EVENT_TO_STATUS,
  ALLOWED_EVENTS,
  safeString,
  safeBool,
  safeTimestamp,
  hashAnon,
};
