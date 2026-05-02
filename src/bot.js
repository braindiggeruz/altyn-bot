import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getUser, createUser, updateUser, logMessage, logEvent,
  getAllUsers, getUsersDueForWarmup, getScheduledBroadcasts, updateBroadcast,
  getBroadcastUsers, pool
} from './database.js';
import {
  WELCOME_TEXT, WELCOME_IMAGE, QUIZ_QUESTIONS, SCENARIO_RESULTS,
  RESULT_IMAGES, WARMUP_MESSAGES, FOLLOWUP_MESSAGES, BOOKING_CONFIRM_TEXT,
  SCENARIO_WARMUPS, TESTIMONIALS, EXIT_SURVEY_TEXT, EXIT_SURVEY_OPTIONS,
  EXIT_FOLLOWUPS, QUIZ_REMINDER_2H, QUIZ_REMINDER_24H,
  BOOKING_REMINDER_30MIN, BOOKING_REMINDER_24H,
  REFERRAL_TEXT, REFERRAL_NOTIFY, TORNADO_MESSAGES
} from './content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// NOTIFICATION TARGETS
// ============================================================
const OWNER_ID = process.env.OWNER_TELEGRAM_ID || null;
const GROUP_ID = process.env.NOTIFY_GROUP_ID || null;

// v4.9.0: Escape Telegram Markdown (legacy mode) special characters in user-supplied text.
// Without this, a single `_` in a username or `*` in booking_request breaks the entire
// notifyAdmin message (logged as ETELEGRAM 400 "can't parse entities"), and the lead
// notification silently never reaches the admin group.
function escapeMd(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/([_*`\[\]])/g, '\\$1');
}

// Telegram supergroup ids start with -100 and MUST be passed as numbers, not strings,
// to node-telegram-bot-api. We coerce explicitly here so a misconfigured env var
// ("-1003406252597") still works.
function coerceTarget(t) {
  if (t === null || t === undefined || t === '') return null;
  const s = String(t).trim();
  // Numeric-looking? Convert to Number. Otherwise leave as-is (e.g. @channel_username).
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export async function notifyAdmin(text, options = {}) {
  if (!bot) {
    console.warn('⚠️ notifyAdmin called before bot was ready');
    if (global.__addError) global.__addError('notifyAdmin', 'bot not initialized', '');
    return { ok: false, reason: 'bot_not_ready' };
  }
  // v4.8.3: Group-only routing. Owner ID is NOT a target by default — it caused
  // duplicate "new user / hot lead" notifications to land in the owner's PRIVATE
  // chat with the bot, where the user could literally see them next to their own
  // /start. Only fall back to OWNER_ID if GROUP_ID is unset.
  const primary = GROUP_ID ? [GROUP_ID] : (OWNER_ID ? [OWNER_ID] : []);
  const targets = [...new Set(primary.map(coerceTarget).filter(Boolean))];
  if (targets.length === 0) {
    console.warn('⚠️ notifyAdmin: no targets configured (NOTIFY_GROUP_ID / OWNER_TELEGRAM_ID)');
    if (global.__addError) global.__addError('notifyAdmin', 'no targets configured', '');
    return { ok: false, reason: 'no_targets' };
  }
  let successes = 0;
  for (const target of targets) {
    try {
      await bot.sendMessage(target, text, { parse_mode: 'Markdown', ...options });
      console.log(`📢 notifyAdmin → ${target}: OK`);
      successes++;
    } catch (e) {
      const msg = `Notify error for ${target}: ${e.message}`;
      console.error('❌ ' + msg);
      if (global.__addError) global.__addError('notifyAdmin', msg, e.stack || '');
      // Try plain-text fallback if Markdown parsing was the issue
      if (/can't parse entities|parse_mode/i.test(e.message)) {
        try {
          await bot.sendMessage(target, text, { ...options, parse_mode: undefined });
          console.log(`📢 notifyAdmin → ${target}: OK (plain-text fallback)`);
          successes++;
        } catch (e2) {
          console.error(`❌ notifyAdmin fallback also failed for ${target}: ${e2.message}`);
          if (global.__addError) global.__addError('notifyAdmin', `fallback failed for ${target}: ${e2.message}`, e2.stack || '');
        }
      }
    }
  }
  return { ok: successes > 0, sent_to: successes, total_targets: targets.length };
}

let bot;

// ============================================================
// v4.8.0: PRODUCTION HARDENING HELPERS
// ============================================================

// Concurrency guard: prevent the same cron task from running twice in parallel
// (e.g. if a previous run is still flushing messages when the next tick fires).
const _cronLocks = new Map();
export function runOnce(name, fn) {
  if (_cronLocks.get(name)) {
    console.log(`⏳ [${name}] previous run still in progress, skipping this tick`);
    return Promise.resolve({ skipped: true });
  }
  _cronLocks.set(name, true);
  const start = Date.now();
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.error(`❌ [${name}] failed:`, err.message, err.stack);
      if (global.__addError) global.__addError(name, err.message, err.stack);
    })
    .finally(() => {
      _cronLocks.delete(name);
      console.log(`🕒 [${name}] finished in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Telegram-friendly send wrapper: retries on 429 (Too Many Requests) using
// `retry_after`, marks 403 (blocked) users for warmup deactivation, and never
// throws — returns { ok, error } for callers that need to know success/failure.
async function sendSafe(method, chatId, ...args) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await bot[method](chatId, ...args);
      return { ok: true, result: res };
    } catch (err) {
      lastErr = err;
      const code = err?.response?.statusCode || err?.code;
      const retryAfter = err?.response?.body?.parameters?.retry_after;
      if (code === 429 && retryAfter) {
        const waitMs = (retryAfter + 1) * 1000;
        console.log(`⏳ Telegram 429 for ${chatId}, sleeping ${waitMs}ms (attempt ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      }
      if (code === 403 || (typeof err.message === 'string' && err.message.includes('403'))) {
        await handleBlockedUser(chatId, err);
        return { ok: false, error: 'blocked' };
      }
      // Other errors (400 for bad markdown, network, etc.) — don't retry blindly
      console.error(`sendSafe ${method} → ${chatId} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: lastErr?.message || 'unknown' };
}

// ============================================================
// HELPER: Progress bar for quiz
// ============================================================
function quizProgressBar(current, total) {
  const filled = Math.round((current / total) * 7);
  const empty = 7 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${current}/${total}`;
}

// ============================================================
// HELPER: Typing indicator with delay
// ============================================================
async function sendTyping(chatId, delayMs = 1000) {
  try {
    await bot.sendChatAction(chatId, 'typing');
    await new Promise(r => setTimeout(r, delayMs));
  } catch(e) {}
}

// ============================================================
// HELPER: Remove inline keyboard from a message
// ============================================================
async function removeKeyboard(chatId, messageId) {
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch(e) {}
}

// ============================================================
// HELPER: Phone number validation
// ============================================================
function isValidPhone(text) {
  const cleaned = text.replace(/[\s\-\(\)\.]/g, '');
  return /^(\+?[78]\d{10}|\+?998\d{9}|\+\d{10,14}|\d{10,11})$/.test(cleaned);
}

// ============================================================
// HELPER: Safely disable warmup for blocked users
// ============================================================
async function handleBlockedUser(telegramId, err) {
  if (
    (err.response && err.response.statusCode === 403) ||
    (err.code === 'ETELEGRAM' && err.message && err.message.includes('403'))
  ) {
    await updateUser(telegramId, { warmup_active: 0 }, true);
    console.log(`🚫 User ${telegramId} blocked bot — warmup disabled`);
    return true;
  }
  return false;
}

// ============================================================
// INIT BOT — Webhook mode for Railway, polling for local dev
// ============================================================
export function initBot(token, app) {
  const WEBHOOK_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.WEBHOOK_URL || null;

  if (WEBHOOK_URL) {
    // ========== WEBHOOK MODE (Production on Railway) ==========
    console.log(`🔗 Starting bot in WEBHOOK mode: ${WEBHOOK_URL}/bot${token.slice(0, 5)}...`);
    bot = new TelegramBot(token, { webHook: false });

    const webhookPath = `/bot${token}`;
    bot.setWebHook(`${WEBHOOK_URL}${webhookPath}`, {
      allowed_updates: ['message', 'callback_query', 'my_chat_member', 'chat_member']
    })
      .then(() => console.log('✅ Webhook set successfully (with callback_query)'))
      .catch(err => console.error('❌ Webhook set error:', err.message));

    if (app) {
      app.post(webhookPath, (req, res) => {
        try {
          const body = req.body;
          const updateType = body?.message ? 'message' : body?.callback_query ? 'callback' : 'other';
          const fromId = body?.message?.from?.id || body?.callback_query?.from?.id || 'unknown';
          const text = body?.message?.text?.substring(0, 30) || body?.callback_query?.data || '';
          console.log(`📨 [${new Date().toISOString()}] Webhook: ${updateType} from ${fromId}: ${text}`);
          bot.processUpdate(body);
          res.sendStatus(200);
        } catch (err) {
          console.error(`❌ Webhook processUpdate error:`, err.message, err.stack);
          if (global.__addError) global.__addError('webhook', err.message, err.stack);
          res.sendStatus(200); // Always return 200 to prevent Telegram retries
        }
      });
      console.log(`✅ Webhook route registered at POST ${webhookPath}`);
    } else {
      console.error('❌ App not provided to initBot! Webhook route NOT registered!');
    }
  } else {
    // ========== POLLING MODE (Local development) ==========
    console.log('🔄 Starting bot in POLLING mode (local dev)');
    bot = new TelegramBot(token, {
      polling: {
        interval: 1000,
        autoStart: true,
        params: { timeout: 30 }
      }
    });
  }

  // /start command
  bot.onText(/\/start(.*)/, async (msg, match) => {
   try {
    const chatId = msg.chat.id;
    const param = match[1] ? match[1].trim() : '';
    console.log(`📩 /start received from ${chatId} (param: '${param}')`);

    let source = 'organic';
    let utm = {};
    let referrerId = null;

    if (param) {
      if (param.startsWith('ref_')) {
        referrerId = param.replace('ref_', '');
        source = 'referral';
        utm = { utm_source: 'referral', utm_medium: 'bot', utm_campaign: referrerId };
      } else {
        const parts = param.split('_');
        source = parts[0] || 'link';
        utm = { utm_source: parts[0], utm_medium: parts[1], utm_campaign: parts[2] };
      }
    }

    await createUser({
      telegram_id: chatId,
      username: msg.from.username,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name,
      source
    });

    const existingUser = await getUser(chatId);
    const alreadyBooked = existingUser && ['booked', 'confirmed', 'completed'].includes(existingUser.booking_status);

    if (alreadyBooked) {
      await updateUser(chatId, {
        last_active: new Date().toISOString(),
        referred_by: referrerId || undefined,
        ...utm
      });
    } else {
      await updateUser(chatId, {
        funnel_stage: 'started',
        quiz_answers: null,
        quiz_score: 0,
        scenario: null,
        warmup_day: 0,
        warmup_active: 1,
        booking_status: 'none',
        booking_name: null,
        booking_request: null,
        booking_time: null,
        referred_by: referrerId || undefined,
        ...utm
      });
    }

    // Track referral
    if (referrerId) {
      try {
        const { trackReferral } = await import('./database.js');
        await trackReferral(referrerId, chatId);
        const referrer = await getUser(parseInt(referrerId));
        if (referrer) {
          const newName = msg.from.first_name || 'Кто-то';
          bot.sendMessage(referrer.telegram_id, REFERRAL_NOTIFY(escapeMd(referrer.first_name || 'друг'), escapeMd(newName)), {
            parse_mode: 'Markdown'
          }).catch(() => {});
        }
      } catch (e) {
        console.error('Referral tracking error:', e.message);
      }
    }

    // v4.9.0: Bullet-proof welcome delivery. Photo is optional decoration; the
    // "Пройти тест" button MUST always reach the user, otherwise the funnel
    // dies at step zero. We try photo first; on any failure (size, network,
    // markdown caption issue) we fall through to plain text + button.
    const welcomeKeyboard = {
      inline_keyboard: [[
        { text: '🔮 Пройти тест', callback_data: 'quiz_start' }
      ]]
    };
    let welcomeDelivered = false;
    try {
      const imgPath = path.resolve(__dirname, '..', 'assets', 'welcome.png');
      if (fs.existsSync(imgPath)) {
        try {
          await bot.sendPhoto(chatId, imgPath, {
            caption: WELCOME_TEXT,
            parse_mode: 'Markdown',
            reply_markup: welcomeKeyboard
          });
          welcomeDelivered = true;
        } catch (photoErr) {
          console.error(`Welcome photo failed for ${chatId}, falling back to text:`, photoErr.message);
        }
      }
    } catch (err) {
      console.error('Welcome image path error:', err.message);
    }
    if (!welcomeDelivered) {
      try {
        await bot.sendMessage(chatId, WELCOME_TEXT, {
          parse_mode: 'Markdown',
          reply_markup: welcomeKeyboard
        });
      } catch (mdErr) {
        // Last-resort: drop markdown entirely so the user at least sees the button
        console.error(`Welcome markdown failed for ${chatId}, sending plain:`, mdErr.message);
        await bot.sendMessage(chatId, WELCOME_TEXT.replace(/[*_`]/g, ''), {
          reply_markup: welcomeKeyboard
        });
      }
    }

    await logMessage(chatId, 'out', 'welcome', 'Welcome message sent');
    console.log(`✅ /start completed for ${chatId}`);

    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    const uname = msg.from.username ? `@${msg.from.username}` : 'нет username';
    notifyAdmin(
      `🆕 *Новый пользователь!*\n\n👤 ${escapeMd(name)}\n📱 ${escapeMd(uname)}\n🆔 \`${chatId}\`\n📊 Источник: ${escapeMd(source)}${referrerId ? `\n🔗 Реферал от: ${escapeMd(referrerId)}` : ''}`
    );
   } catch (fatalErr) {
    console.error(`❌ FATAL /start error for ${msg?.chat?.id}:`, fatalErr.message, fatalErr.stack);
    if (global.__addError) global.__addError('/start', fatalErr.message, fatalErr.stack);
    try {
      await bot.sendMessage(msg.chat.id, '⚠️ Произошла ошибка. Попробуйте ещё раз через минуту или напишите /start', { parse_mode: 'Markdown' });
    } catch(e) { console.error('Could not send error message:', e.message); }
   }
  });

  // ============================================================
  // CALLBACK QUERIES
  // ============================================================
  bot.on('callback_query', async (query) => {
   try {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    console.log(`📩 Callback received: ${data} from ${chatId}`);

    await bot.answerCallbackQuery(query.id);

    // ---- Quiz start ----
    if (data === 'quiz_start') {
      await logEvent('quiz_start', chatId, {});
      await updateUser(chatId, {
        funnel_stage: 'quiz',
        quiz_answers: JSON.stringify([]),
        quiz_started_at: new Date().toISOString()
      });
      await removeKeyboard(chatId, messageId);
      await sendTyping(chatId, 500);
      await sendQuizQuestion(chatId, 0);
      return;
    }

    // ---- Quiz answer ----
    if (data.startsWith('quiz_')) {
      const parts = data.split('_');
      if (parts[1] === 'start') return;
      const qIndex = parseInt(parts[1]);
      const aIndex = parseInt(parts[2]);

      if (isNaN(qIndex) || isNaN(aIndex)) return;
      if (qIndex < 0 || qIndex >= QUIZ_QUESTIONS.length) return;
      if (aIndex < 0 || aIndex >= QUIZ_QUESTIONS[qIndex].options.length) return;

      const user = await getUser(chatId);
      if (!user) return;

      let answers = [];
      try { answers = JSON.parse(user.quiz_answers || '[]'); } catch(e) { answers = []; }

      // Double-click protection
      if (answers.some(a => a.question === qIndex)) return;

      answers.push({ question: qIndex, answer: aIndex });
      await updateUser(chatId, { quiz_answers: JSON.stringify(answers) });
      await removeKeyboard(chatId, messageId);

      if (qIndex + 1 < QUIZ_QUESTIONS.length) {
        await sendTyping(chatId, 500);
        await sendQuizQuestion(chatId, qIndex + 1);
      } else {
        await sendTyping(chatId, 1500);
        await sendQuizResult(chatId, answers);
      }
      return;
    }

    // ---- Continue quiz (from reminder) ----
    if (data === 'continue_quiz') {
      const user = await getUser(chatId);
      if (!user) return;
      let answers = [];
      try { answers = JSON.parse(user.quiz_answers || '[]'); } catch(e) {}
      const nextQ = answers.length;
      if (nextQ < QUIZ_QUESTIONS.length) {
        await removeKeyboard(chatId, messageId);
        await sendQuizQuestion(chatId, nextQ);
      }
      return;
    }

    // ---- Restart quiz ----
    if (data === 'restart_quiz') {
      await updateUser(chatId, {
        funnel_stage: 'quiz',
        quiz_answers: JSON.stringify([]),
        quiz_started_at: new Date().toISOString()
      });
      await removeKeyboard(chatId, messageId);
      await sendQuizQuestion(chatId, 0);
      return;
    }

    // ---- Book diagnostic ----
    if (data === 'book_diagnostic') {
      const user = await getUser(chatId);
      if (user && ['booked', 'confirmed', 'completed'].includes(user.booking_status)) {
        await bot.sendMessage(chatId, '✅ Вы уже записаны на диагностику! Если нужно изменить время — напишите в WhatsApp.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
            ]
          }
        });
        return;
      }
      await updateUser(chatId, {
        funnel_stage: 'booking',
        booking_name: null,
        booking_request: null,
        booking_time: null,
        booking_started_at: new Date().toISOString()
      });
      await removeKeyboard(chatId, messageId);
      const name = user?.first_name || '';
      await bot.sendMessage(chatId, `📝 *Запись на бесплатную диагностику*\n\n${name ? `${escapeMd(name)}, к` : 'К'}ак вас зовут? (Имя и фамилия)`, {
        parse_mode: 'Markdown'
      });
      await logEvent('booking_start', chatId, {});
      return;
    }

    // ---- Continue booking (from reminder) ----
    if (data === 'continue_booking') {
      const user = await getUser(chatId);
      if (!user) return;
      await removeKeyboard(chatId, messageId);
      if (!user.booking_name) {
        await bot.sendMessage(chatId, '📝 Как вас зовут? (Имя и фамилия)', { parse_mode: 'Markdown' });
      } else if (!user.booking_request) {
        await bot.sendMessage(chatId, `✍️ *${escapeMd(user.booking_name)}*, опишите кратко ваш запрос — с чем хотите поработать?`, { parse_mode: 'Markdown' });
      } else if (!user.booking_time) {
        await bot.sendMessage(chatId, '📅 Когда вам удобно? Напишите желаемую дату и время', { parse_mode: 'Markdown' });
      }
      return;
    }

    // ---- Get referral link ----
    if (data === 'get_referral') {
      const code = `ref_${chatId}`;
      const link = `https://t.me/altyntherapybot?start=${code}`;
      await bot.sendMessage(chatId, REFERRAL_TEXT(link), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📤 Поделиться', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Пройди бесплатный тест!')}` }]
          ]
        }
      });
      return;
    }

    // ---- Confirm booking (admin) ----
    if (data.startsWith('confirm_booking_')) {
      const targetId = parseInt(data.replace('confirm_booking_', ''));
      // FIX v4.8.0: Don't set session_completed_at on confirm — that timestamp is for AFTER
      // the actual session ends. Use booking_confirmed_at to track confirmation.
      await updateUser(targetId, {
        booking_status: 'confirmed',
        booking_confirmed_at: new Date().toISOString()
      }, true);
      try {
        await bot.sendMessage(targetId, '✅ *Ваша запись подтверждена!*\n\nАлтын свяжется с вами в ближайшее время. Ожидайте сообщение!', {
          parse_mode: 'Markdown'
        });
      } catch(e) {}
      await bot.sendMessage(chatId, `✅ Запись для пользователя ${targetId} подтверждена.`);
      return;
    }

    // ---- TORNADO stop ----
    if (data === 'tornado_stop') {
      await pool.query(
        `UPDATE users SET tornado_day = 30, tornado_disabled = 1, exit_reason = 'tornado_stop' WHERE telegram_id = $1`,
        [chatId]
      );
      await logEvent('tornado_stopped', chatId, {});
      // FIX v4.7.0: was callbackQuery.id (undefined), should be query.id
      // Note: answerCallbackQuery already called at top of handler, skip duplicate
      await bot.sendMessage(chatId,
        `✅ Поняла. Больше не буду беспокоить.

Если передумаете — напишите мне любое сообщение или запишитесь через WhatsApp. 🙏`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Написать Алтын', url: 'https://t.me/altyntherapy' }]
            ]
          }
        }
      );
      return;
    }

    // ---- Exit survey answers ----
    if (data.startsWith('exit_')) {
      await updateUser(chatId, { exit_reason: data, warmup_active: 0 }, true);
      await logEvent('exit_survey_answer', chatId, { reason: data });
      await removeKeyboard(chatId, messageId);

      const followup = EXIT_FOLLOWUPS[data];
      if (followup) {
        await bot.sendMessage(chatId, followup, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Записаться на диагностику', callback_data: 'book_diagnostic' }],
              [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
            ]
          }
        });
      } else {
        await bot.sendMessage(chatId, 'Спасибо за ответ! 🙏 Если передумаете — мы всегда рядом.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Записаться', callback_data: 'book_diagnostic' }]
            ]
          }
        });
      }
      return;
    }
   } catch (fatalErr) {
    console.error(`❌ FATAL callback error for ${query?.message?.chat?.id}:`, fatalErr.message, fatalErr.stack);
    if (global.__addError) global.__addError('callback', fatalErr.message, fatalErr.stack);
    try {
      await bot.sendMessage(query.message.chat.id, '⚠️ Произошла ошибка. Попробуйте ещё раз.');
    } catch(e) {}
   }
  });
  // ============================================================
  // TEXT MESSAGES — State-machine booking floww
  // ============================================================
  bot.on('message', async (msg) => {
   try {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return;
    const chatId = msg.chat.id;
    console.log(`📩 Message received from ${chatId}: ${msg.text?.substring(0, 50)}`);
    const user = await getUser(chatId);
    if (!user) return;

    // ---- v4.9.2: TORNADO / warmup text-based unsubscribe ----
    // User-typed stop words bypass the booking state-machine and immediately
    // disable proactive outreach. We do NOT wipe other data (booking, scenario,
    // referral attribution) — only the warm-up channels.
    {
      const t = msg.text.trim().toLowerCase();
      const stopWords = [
        'стоп', 'stop', 'отписаться', 'отписка', 'unsubscribe',
        'хватит', 'не писать', 'не пиши', 'отстань', 'убрать рассылку',
        'не беспокоить', 'no spam', 'остановить рассылку'
      ];
      const isStop = stopWords.some(w => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w) || t.includes(' ' + w + ' '));
      if (isStop) {
        await pool.query(
          `UPDATE users SET tornado_disabled = 1, warmup_active = 0, tornado_day = 30,
            exit_reason = COALESCE(NULLIF(exit_reason,''), 'user_stop')
            WHERE telegram_id = $1`,
          [chatId]
        );
        await logEvent('tornado_unsubscribed', chatId, { trigger: 'text', message: t.slice(0, 60) });
        await logMessage(chatId, 'in', 'unsubscribe', msg.text);
        await bot.sendMessage(chatId,
          '✅ Поняла. Больше не буду беспокоить рассылками.\n\nЕсли передумаете — напишите мне или запишитесь напрямую.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
              ]
            }
          }
        ).catch(() => {});
        return;
      }
    }

    // ---- BOOKING FLOW: State machine approach ----
    if (user.funnel_stage === 'booking') {

      // Step 1: Waiting for name
      if (!user.booking_name) {
        const nameInput = msg.text.trim();
        if (nameInput.length < 2) {
          await bot.sendMessage(chatId, '⚠️ Пожалуйста, введите ваше имя и фамилию.');
          return;
        }
        await updateUser(chatId, { booking_name: nameInput });
        await logMessage(chatId, 'in', 'booking_name', msg.text);
        await sendTyping(chatId, 500);
        await bot.sendMessage(chatId, `✍️ Приятно познакомиться, *${escapeMd(nameInput)}*!\n\nОпишите кратко ваш запрос — с чем хотите поработать?`, {
          parse_mode: 'Markdown'
        });
        return;
      }

      // Step 2: Waiting for request description
      if (!user.booking_request) {
        await updateUser(chatId, { booking_request: msg.text.trim() });
        await logMessage(chatId, 'in', 'booking_request', msg.text);
        await sendTyping(chatId, 500);
        await bot.sendMessage(chatId, '📅 Когда вам удобно? Напишите желаемую дату и время\n\n_Например: «Среда, 18:00» или «Завтра после 15:00»_', {
          parse_mode: 'Markdown'
        });
        return;
      }

      // Step 3: Waiting for time
      if (!user.booking_time) {
        await updateUser(chatId, {
          booking_time: msg.text.trim(),
          booking_status: 'booked',
          funnel_stage: 'booked'
        });
        const updatedUser = await getUser(chatId);
        const name = updatedUser.booking_name || updatedUser.first_name || 'друг';
        await logMessage(chatId, 'in', 'booking_time', msg.text);
        await logEvent('booking_complete', chatId, { name, request: updatedUser.booking_request, time: msg.text });
        await sendTyping(chatId, 1000);
        await bot.sendMessage(chatId, BOOKING_CONFIRM_TEXT(escapeMd(name)), {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎁 Пригласить друга (скидка 10%)', callback_data: 'get_referral' }],
              [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }],
              [{ text: '📸 Instagram', url: 'https://instagram.com/altyn.therapy' }]
            ]
          }
        });

        // AUTO-HANDOFF: Notify admin group with full lead details
        const scenario = updatedUser.scenario || 'не определён';
        const scenarioTitle = SCENARIO_RESULTS[updatedUser.scenario]?.title || scenario;
        const uname = updatedUser.username ? `@${updatedUser.username}` : 'нет username';
        const ownerMsg = `🔥🔥🔥 *ГОРЯЧИЙ ЛИД!*\n\n` +
          `👤 *Имя:* ${escapeMd(updatedUser.booking_name)}\n` +
          `📱 *Telegram:* ${escapeMd(uname)}\n` +
          `🆔 *ID:* \`${chatId}\`\n` +
          `🎭 *Сценарий:* ${escapeMd(scenarioTitle)}\n` +
          `📝 *Запрос:* ${escapeMd(updatedUser.booking_request)}\n` +
          `📅 *Время:* ${escapeMd(msg.text)}\n` +
          `📊 *Источник:* ${escapeMd(updatedUser.source || 'organic')}\n` +
          `${updatedUser.utm_campaign ? `📎 *Кампания:* ${escapeMd(updatedUser.utm_campaign)}\n` : ''}` +
          `\n⚡ *Действие:* Свяжитесь в течение 30 минут!\n` +
          `📞 Написать: tg://user?id=${chatId}`;

        await notifyAdmin(ownerMsg, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Подтвердить запись', callback_data: `confirm_booking_${chatId}` }],
              [{ text: '📞 Написать клиенту', url: `tg://user?id=${chatId}` }]
            ]
          }
        });

        await updateUser(chatId, { warmup_active: 0 }, true);
        return;
      }
    }
   } catch (fatalErr) {
    console.error(`❌ FATAL message error for ${msg?.chat?.id}:`, fatalErr.message, fatalErr.stack);
    if (global.__addError) global.__addError('message', fatalErr.message, fatalErr.stack);
   }
  });

  // ============================================================
  // COMMANDS
  // ============================================================
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔮 *Алтын | Гипнотерапевт*\n\n' +
      '📋 Доступные команды:\n' +
      '/start — Начать сначала\n' +
      '/quiz — Пройти тест\n' +
      '/book — Записаться на диагностику\n' +
      '/referral — Пригласить друга\n' +
      '/help — Помощь\n\n' +
      '💬 WhatsApp: +7 707 719 85 61', {
      parse_mode: 'Markdown'
    });
  });

  bot.onText(/\/quiz/, async (msg) => {
    const chatId = msg.chat.id;
    await updateUser(chatId, {
      funnel_stage: 'quiz',
      quiz_answers: JSON.stringify([]),
      quiz_started_at: new Date().toISOString()
    });
    await sendQuizQuestion(chatId, 0);
  });

  bot.onText(/\/book/, async (msg) => {
    const chatId = msg.chat.id;
    await updateUser(chatId, {
      funnel_stage: 'booking',
      booking_name: null,
      booking_request: null,
      booking_time: null,
      booking_started_at: new Date().toISOString()
    });
    const user = await getUser(chatId);
    const name = user?.first_name || '';
    await bot.sendMessage(chatId, `📝 *Запись на бесплатную диагностику*\n\n${name ? `${escapeMd(name)}, к` : 'К'}ак вас зовут? (Имя и фамилия)`, {
      parse_mode: 'Markdown'
    });
  });

  bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    const code = `ref_${chatId}`;
    const link = `https://t.me/altyntherapybot?start=${code}`;
    await bot.sendMessage(chatId, REFERRAL_TEXT(link), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📤 Поделиться', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Пройди бесплатный тест!')}` }]
        ]
      }
    });
  });

  // Handle polling errors gracefully (only in polling mode)
  bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.response?.statusCode === 409) {
      console.error('⚠️ CONFLICT: Another bot instance is running with the same token!');
    } else if (err.code === 'ETELEGRAM' && err.response?.statusCode === 401) {
      console.error('❌ INVALID BOT TOKEN! Check BOT_TOKEN environment variable.');
    } else {
      console.error('Polling error:', err.code, err.message);
    }
  });

  console.log('🤖 Altyn Therapy Bot v4.8.0 started');
  return bot;
}

// ============================================================
// QUIZ QUESTION SENDER (with progress bar)
// ============================================================
async function sendQuizQuestion(chatId, index) {
  const q = QUIZ_QUESTIONS[index];
  const progress = quizProgressBar(index + 1, QUIZ_QUESTIONS.length);
  const keyboard = q.options.map((opt, i) => [{
    text: opt.text,
    callback_data: `quiz_${index}_${i}`
  }]);

  await bot.sendMessage(chatId, `${progress}\n\n*Вопрос ${index + 1}*\n\n${q.text}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ============================================================
// QUIZ RESULT CALCULATOR
// ============================================================
async function sendQuizResult(chatId, answers) {
  const scores = { savior: 0, fear: 0, control: 0, freeze: 0 };

  for (const a of answers) {
    const q = QUIZ_QUESTIONS[a.question];
    if (!q || !q.options[a.answer]) continue;
    const weights = q.options[a.answer].scores;
    for (const [key, val] of Object.entries(weights)) {
      if (scores[key] !== undefined) scores[key] += val;
    }
  }

  const scenario = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  const result = SCENARIO_RESULTS[scenario];

  if (!result) {
    await bot.sendMessage(chatId, '⚠️ Произошла ошибка при расчёте результата. Попробуйте /start');
    return;
  }

  await updateUser(chatId, {
    scenario,
    quiz_score: JSON.stringify(scores),
    funnel_stage: 'quiz_completed',
    warmup_active: 1,
    warmup_day: 0,
    quiz_completed_at: new Date().toISOString(),
    last_warmup_sent_at: null
  });
  await logEvent('quiz_completed', chatId, { scenario, scores });
  await logMessage(chatId, 'out', 'quiz_result', scenario);

  // v4.9.0: Bullet-proof result delivery — multi-stage fallback so the user
  // ALWAYS sees their result, even if the image is missing, the photo upload
  // times out, the caption is too long, or markdown parsing fails.
  // Telegram caption limit is 1024 chars — sending the full result.text as a
  // caption silently truncates and may break parse_mode.
  try {
    const imgKey = result.image || scenario;
    const imgPath = path.resolve(__dirname, '..', 'assets', `result_${imgKey}.png`);
    let imageSent = false;
    if (fs.existsSync(imgPath)) {
      try {
        await bot.sendPhoto(chatId, imgPath, { caption: result.title || '' });
        imageSent = true;
      } catch (photoErr) {
        console.error(`sendPhoto failed for ${chatId}, falling back to text-only:`, photoErr.message);
      }
    }
    // Always send the full text as a separate message so result.text is never lost.
    try {
      await bot.sendMessage(chatId, result.text, { parse_mode: 'Markdown' });
    } catch (mdErr) {
      console.error(`sendMessage(Markdown) failed for ${chatId}, retrying plain:`, mdErr.message);
      await bot.sendMessage(chatId, result.text);
    }
  } catch (err) {
    console.error('Error sending result image+text:', err.message);
    if (global.__addError) global.__addError('quiz_result', err.message, err.stack);
    try {
      await bot.sendMessage(chatId, result.text);
    } catch(e) {}
  }

  // Send CTA after result
  await new Promise(r => setTimeout(r, 2000));
  await bot.sendMessage(chatId, `🔑 *Что дальше?*\n\nТеперь, когда вы знаете свой сценарий, вы можете:\n\n1️⃣ Записаться на *бесплатную диагностику* — я помогу разобраться глубже\n2️⃣ Получать полезные материалы по вашему сценарию\n\n_Диагностика длится 30 минут и проходит онлайн_`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Записаться на бесплатную диагностику', callback_data: 'book_diagnostic' }],
        [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }],
        [{ text: '📸 Instagram', url: 'https://instagram.com/altyn.therapy' }]
      ]
    }
  });

  // Notify admin about quiz completion — full lead card
  const user = await getUser(chatId);
  const uname = user?.username ? `@${user.username}` : 'нет username';
  const scenarioEmoji = { savior: '🛡', fear: '💔', control: '🎯', freeze: '❄️' }[scenario] || '🎭';
  const scenarioTitle = result.title || scenario;
  const scoreStr = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');

  notifyAdmin(
    `🧠 *Новый лид прошёл квиз!*\n\n` +
    `👤 *Имя:* ${escapeMd(user?.first_name || 'Аноним')} ${escapeMd(user?.last_name || '')}`.trim() + `\n` +
    `📱 *Telegram:* ${escapeMd(uname)}\n` +
    `🆔 *ID:* \`${chatId}\`\n` +
    `${scenarioEmoji} *Сценарий:* ${escapeMd(scenarioTitle)}\n` +
    `📊 *Баллы:* ${scoreStr}\n` +
    `📅 *Время:* ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}\n\n` +
    `💡 _Человек видит результат и кнопку записи прямо сейчас!_`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📞 Написать клиенту', url: `tg://user?id=${chatId}` }],
          [{ text: '📝 Открыть CRM', url: 'https://altyn-bot-production.up.railway.app' }]
        ]
      }
    }
  );
}

// ============================================================
// WARMUP SENDER (called by cron - every day at 10:00 Almaty)
// v4.8.0: Production-grade. Per-user dedup via last_warmup_sent_at, batched
// SQL fetch, rate-limit-safe send, telemetry, idempotent.
// ============================================================
export async function sendWarmupMessages() {
  if (!bot) return { sent: 0, failed: 0, skipped: 0 };

  const users = await getUsersDueForWarmup();
  console.log(`🔥 WARMUP: ${users.length} user(s) due for next message`);

  let sent = 0, failed = 0, skipped = 0, exited = 0;

  for (const user of users) {
    // Defensive double-checks (the SQL already filters, but cron+app race-conditions happen)
    if (!user.warmup_active) { skipped++; continue; }
    if (['booked', 'confirmed', 'completed'].includes(user.booking_status)) {
      await updateUser(user.telegram_id, { warmup_active: 0 }, true);
      skipped++; continue;
    }
    if (user.funnel_stage !== 'quiz_completed') { skipped++; continue; }

    const nextDay = (user.warmup_day || 0) + 1;
    const scenario = user.scenario;

    // Pick the best matching message (scenario-specific → generic warmup → followup)
    let msgToSend = null;
    if (scenario && SCENARIO_WARMUPS[scenario]) {
      msgToSend = SCENARIO_WARMUPS[scenario].find(m => m.day === nextDay);
    }
    if (!msgToSend) msgToSend = WARMUP_MESSAGES.find(m => m.day === nextDay);
    if (!msgToSend) msgToSend = FOLLOWUP_MESSAGES.find(m => m.day === nextDay);

    if (!msgToSend) {
      // No more warmup content for this user. After day 14 → exit survey + deactivate.
      if (nextDay > 14) {
        if (!user.exit_reason) await sendExitSurvey(user.telegram_id);
        await updateUser(user.telegram_id, { warmup_active: 0 }, true);
        exited++;
      } else {
        // Gap in content for an intermediate day — advance counter so we don't get stuck forever
        await updateUser(user.telegram_id, { warmup_day: nextDay }, true);
        await pool.query('UPDATE users SET last_warmup_sent_at = NOW() WHERE telegram_id = $1', [user.telegram_id]);
        skipped++;
      }
      continue;
    }

    const keyboard = nextDay >= 5 ? {
      inline_keyboard: [
        [{ text: '📝 Записаться на диагностику', callback_data: 'book_diagnostic' }],
        [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
      ]
    } : undefined;

    const result = await sendSafe('sendMessage', user.telegram_id, msgToSend.text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });

    if (!result.ok) {
      failed++;
      // If user blocked the bot, sendSafe already deactivated warmup. Otherwise, still bump
      // last_warmup_sent_at so we don't hammer the same broken target every cron tick.
      await pool.query(
        'UPDATE users SET last_warmup_sent_at = NOW() WHERE telegram_id = $1',
        [user.telegram_id]
      );
      continue;
    }

    // Optional social-proof testimonial on days 3 and 6
    if ((nextDay === 3 || nextDay === 6) && scenario && TESTIMONIALS[scenario]) {
      const testimonials = TESTIMONIALS[scenario];
      const idx = nextDay === 3 ? 0 : (testimonials.length > 1 ? 1 : 0);
      await sleep(1500);
      await sendSafe('sendMessage', user.telegram_id, testimonials[idx], { parse_mode: 'Markdown' });
    }

    // Atomically advance day + stamp last_warmup_sent_at so the same user can't be picked
    // up by the same or any subsequent cron run within ~20h.
    await pool.query(
      'UPDATE users SET warmup_day = $1, last_warmup_sent_at = NOW() WHERE telegram_id = $2',
      [nextDay, user.telegram_id]
    );
    await logMessage(user.telegram_id, 'out', 'warmup', `Day ${nextDay} (${scenario || 'generic'})`);
    await logEvent('warmup_sent', user.telegram_id, { day: nextDay, scenario });
    sent++;

    // ~10 msg/s, well under Telegram's 30 msg/s global limit
    await sleep(120);
  }

  console.log(`✅ WARMUP done: sent=${sent}, failed=${failed}, skipped=${skipped}, exited=${exited}`);
  return { sent, failed, skipped, exited };
}

// ============================================================
// REMINDER SENDER (called by cron - every 2 hours)
// ============================================================
// ============================================================
// REMINDER SENDER (called by cron — every 2 hours)
// v4.8.0: Per-channel dedup via last_*_at columns; uses quiz_started_at /
// booking_started_at instead of updated_at (which warmup pollutes); rate-limit
// safe via sendSafe. Returns telemetry.
// ============================================================
export async function sendReminders() {
  if (!bot) return null;

  const stats = { quiz_2h: 0, quiz_24h: 0, booking_30m: 0, booking_24h: 0, session: 0, reactivation: 0, post_session: 0 };

  // Tiny per-channel runner: SQL → build message → send → mark dedup column.
  async function runChannel({ name, sql, dedupColumn, build }) {
    let rows;
    try {
      const res = await pool.query(sql);
      rows = res.rows;
    } catch (e) {
      console.error(`Reminder channel ${name} SQL error:`, e.message);
      return 0;
    }
    let count = 0;
    for (const user of rows) {
      const built = await build(user);
      if (!built) continue;
      const sendRes = await sendSafe('sendMessage', user.telegram_id, built.text, built.options);
      // Mark dedup column on success OR on permanent failure so we don't loop forever
      if (dedupColumn) {
        await pool.query(
          `UPDATE users SET ${dedupColumn} = NOW() WHERE telegram_id = $1`,
          [user.telegram_id]
        );
      }
      if (sendRes.ok) {
        await logEvent('reminder_sent', user.telegram_id, { type: name });
        count++;
      }
      await sleep(120);
    }
    if (rows.length > 0) console.log(`🔔 [reminder:${name}] sent ${count}/${rows.length}`);
    return count;
  }

  // 1. QUIZ STUCK — quiz started 2h+ ago, not finished
  stats.quiz_2h = await runChannel({
    name: 'quiz_2h',
    dedupColumn: 'last_quiz_reminder_2h_at',
    sql: `
      SELECT * FROM users
      WHERE funnel_stage = 'quiz'
      AND warmup_active = 1
      AND quiz_started_at IS NOT NULL
      AND quiz_started_at <= NOW() - INTERVAL '2 hours'
      AND quiz_started_at >= NOW() - INTERVAL '24 hours'
      AND last_quiz_reminder_2h_at IS NULL
    `,
    build: async (user) => {
      let answers = [];
      try { answers = JSON.parse(user.quiz_answers || '[]'); } catch(_) {}
      const questionsLeft = QUIZ_QUESTIONS.length - answers.length;
      if (questionsLeft <= 0) return null;
      return {
        text: QUIZ_REMINDER_2H(questionsLeft),
        options: {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '▶️ Продолжить тест', callback_data: 'continue_quiz' }],
              [{ text: '🔄 Начать заново', callback_data: 'restart_quiz' }]
            ]
          }
        }
      };
    }
  });

  // 2. QUIZ ABANDONED — quiz started 24h+ ago, not finished
  stats.quiz_24h = await runChannel({
    name: 'quiz_24h',
    dedupColumn: 'last_quiz_reminder_24h_at',
    sql: `
      SELECT * FROM users
      WHERE funnel_stage = 'quiz'
      AND warmup_active = 1
      AND quiz_started_at IS NOT NULL
      AND quiz_started_at <= NOW() - INTERVAL '24 hours'
      AND quiz_started_at >= NOW() - INTERVAL '7 days'
      AND last_quiz_reminder_24h_at IS NULL
    `,
    build: async () => ({
      text: QUIZ_REMINDER_24H,
      options: {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔮 Пройти тест', callback_data: 'quiz_start' }]] }
      }
    })
  });

  // 3. BOOKING STUCK — started booking 30 min+ ago, didn't finish
  stats.booking_30m = await runChannel({
    name: 'booking_30m',
    dedupColumn: 'last_booking_reminder_30m_at',
    sql: `
      SELECT * FROM users
      WHERE funnel_stage = 'booking'
      AND (booking_status IS NULL OR booking_status = 'none')
      AND booking_started_at IS NOT NULL
      AND booking_started_at <= NOW() - INTERVAL '30 minutes'
      AND booking_started_at >= NOW() - INTERVAL '6 hours'
      AND last_booking_reminder_30m_at IS NULL
    `,
    build: async (user) => ({
      text: BOOKING_REMINDER_30MIN(escapeMd(user.booking_name || user.first_name || 'друг')),
      options: {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Продолжить запись', callback_data: 'continue_booking' }],
            [{ text: '💬 Написать в WhatsApp', url: 'https://wa.me/77077198561' }]
          ]
        }
      }
    })
  });

  // 4. BOOKING ABANDONED — started 24h+ ago, didn't finish
  stats.booking_24h = await runChannel({
    name: 'booking_24h',
    dedupColumn: 'last_booking_reminder_24h_at',
    sql: `
      SELECT * FROM users
      WHERE funnel_stage = 'booking'
      AND (booking_status IS NULL OR booking_status = 'none')
      AND booking_started_at IS NOT NULL
      AND booking_started_at <= NOW() - INTERVAL '24 hours'
      AND booking_started_at >= NOW() - INTERVAL '7 days'
      AND last_booking_reminder_24h_at IS NULL
    `,
    build: async () => ({
      text: BOOKING_REMINDER_24H,
      options: {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Записаться сейчас', callback_data: 'book_diagnostic' }],
            [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
          ]
        }
      }
    })
  });

  // 5. SESSION REMINDER — ~24h after a session was booked, single fire
  stats.session = await runChannel({
    name: 'session_24h',
    dedupColumn: 'last_session_reminder_at',
    sql: `
      SELECT * FROM users
      WHERE booking_status IN ('booked', 'confirmed')
      AND booking_time IS NOT NULL
      AND booking_started_at IS NOT NULL
      AND booking_started_at <= NOW() - INTERVAL '20 hours'
      AND booking_started_at >= NOW() - INTERVAL '7 days'
      AND last_session_reminder_at IS NULL
    `,
    build: async (user) => {
      const name = escapeMd(user.booking_name || user.first_name || 'друг');
      const time = escapeMd(user.booking_time || 'запланированное время');
      return {
        text: `🔔 *Напоминание о диагностике*\n\n${name}, напоминаю о нашей встрече!\n\n📅 *Время:* ${time}\n\nДиагностика пройдёт онлайн — ссылку я пришлю за 15 минут до начала.\n\nЕсли нужно перенести — напишите в WhatsApp, договоримся.\n\n_До встречи! 🙏\nАлтын, гипнотерапевт_`,
        options: {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '💬 Написать Алтын', url: 'https://wa.me/77077198561' }]]
          }
        }
      };
    }
  });

  // 6. REACTIVATION — quiz_completed but never booked, inactive 7+ days, single fire
  stats.reactivation = await runChannel({
    name: 'reactivation_7d',
    dedupColumn: 'reactivation_sent_at',
    sql: `
      SELECT * FROM users
      WHERE funnel_stage = 'quiz_completed'
      AND (booking_status IS NULL OR booking_status = 'none')
      AND (exit_reason IS NULL OR exit_reason = '')
      AND last_active <= NOW() - INTERVAL '7 days'
      AND last_active >= NOW() - INTERVAL '60 days'
      AND reactivation_sent_at IS NULL
    `,
    build: async (user) => {
      const name = escapeMd(user.first_name || 'друг');
      const scenario = user.scenario || 'freeze';
      const scenarioEmoji = { savior: '🛡', fear: '💔', control: '🎯', freeze: '❄️' }[scenario] || '🎭';
      const scenarioNames = { savior: 'Спасатель', fear: 'Страх близости', control: 'Гиперконтроль', freeze: 'Заморозка' };
      const scenarioName = scenarioNames[scenario] || scenario;
      return {
        text: `${scenarioEmoji} *${name}, вы ещё думаете?*\n\nНеделю назад вы прошли тест и узнали свой сценарий — *«${scenarioName}»*.\n\nЯ понимаю: принять решение непросто. Но пока вы думаете, сценарий продолжает работать. Каждый день.\n\n*Вот что происходит в вашей психике:*\n◇ Сценарий автоматически повторяется в отношениях\n◇ Вы теряете возможности и деньги\n◇ Каждый день становится сложнее\n\n💬 Я предлагаю просто поговорить — 30 минут, бесплатно, без обязательств. На диагностике вы:\n◇ Поймёте корень проблемы\n◇ Почувствуете первые изменения\n◇ Узнаете план работы\n\nМест на этой неделе осталось немного. Запишитесь сейчас 👇`,
        options: {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Записаться на диагностику', callback_data: 'book_diagnostic' }],
              [{ text: '💬 Написать в WhatsApp', url: 'https://wa.me/77077198561' }]
            ]
          }
        }
      };
    }
  });

  // 7. POST-SESSION FOLLOW-UP — 2 days after session_completed_at, once
  const postSessionResult = await pool.query(`
    SELECT * FROM users
    WHERE booking_status IN ('confirmed', 'completed')
    AND session_completed_at IS NOT NULL
    AND post_session_followup_sent = 0
    AND session_completed_at <= NOW() - INTERVAL '2 days'
    AND session_completed_at >= NOW() - INTERVAL '14 days'
  `);
  for (const user of postSessionResult.rows) {
    const name = escapeMd(user.booking_name || user.first_name || 'друг');
    const sendRes = await sendSafe('sendMessage', user.telegram_id,
      `🌟 *${name}, как прошла диагностика?*\n\nНадеюсь, вы почувствовали ясность и понимание своего запроса. Это уже результат.\n\n*Что заметили клиенты после диагностики:*\n◇ Стало легче — просто от того, что поговорили\n◇ Появилось понимание, откуда растёт проблема\n◇ Захотелось идти глубже и менять ситуацию\n\n*Следующий шаг:*\nПолная программа гипнотерапии (8 сессий) даёт *устойчивый результат*. Многие клиенты видят изменения уже после 3-4 сессий.\n\n💰 *Цена:* 50,000 тенге за программу (или 7,000 за сессию)\n⏱️ *Длительность:* 1 месяц (2 сессии в неделю)\n✅ *Гарантия:* Если не почувствуете результат — вернём 50% стоимости\n\n_Напишите мне — обсудим ваш путь._`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Написать Алтын', url: 'https://wa.me/77077198561' }],
            [{ text: '📸 Instagram', url: 'https://instagram.com/altyn.therapy' }]
          ]
        }
      }
    );
    // Mark as sent regardless to prevent re-firing on next cron tick
    await pool.query(
      'UPDATE users SET post_session_followup_sent = 1 WHERE telegram_id = $1',
      [user.telegram_id]
    );
    if (sendRes.ok) {
      await logEvent('post_session_followup_sent', user.telegram_id, { session_completed_at: user.session_completed_at });
      stats.post_session++;
    }
    await sleep(120);
  }

  console.log(`✅ REMINDERS done:`, JSON.stringify(stats));
  return stats;
}

// ============================================================
// 🌪️ TORNADO REACTIVATION — 30-day reactivation chain
// v4.9.2: dry-run + test mode + batch limit + tornado_disabled kill-switch
//   + warmup-collision guard + smart counter advance (only burn a day on
//   successful send or terminal-block; soft errors keep the day for retry).
// ============================================================
//
// Options:
//   dryRun        — true → no send, no DB write, just return candidate list
//   limit         — max users this run (default 50, cap 100)
//   onlyTelegramIds — array of TG ids; restricts query to these users only
//   source        — string label for logging ('cron'|'manual'|'test'|'batch')
//
// Returns: { candidates, considered, sent, failed, blocked, skipped, reasons[], details[] }
// ============================================================
export async function sendTornadoReactivation(opts = {}) {
  const { dryRun = false, limit = 50, onlyTelegramIds = null, source = 'cron' } = opts;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));

  if (!bot) {
    console.warn(`🌪️ TORNADO[${source}]: bot not initialized`);
    return { sent: 0, failed: 0, candidates: 0, considered: 0, blocked: 0, skipped: 0, error: 'bot_not_ready' };
  }

  // ---- Build query: shared eligibility predicate ----
  // The handoff schema is the source of truth: funnel_stage / last_active /
  // booking_status / telegram_id / tornado_day / tornado_last_sent.
  // We deliberately also accept 'started' because users who hit /start but
  // never finished the quiz (and went silent for 7+ days) are exactly the
  // cohort TORNADO is designed to recover.
  const whereParts = [
    `telegram_id IS NOT NULL`,
    `funnel_stage IN ('started','quiz','quiz_completed','warmup','booking')`,
    `(booking_status IS NULL OR booking_status NOT IN ('booked','confirmed','completed'))`,
    `(exit_reason IS NULL OR exit_reason = '')`,
    `(tornado_disabled IS NULL OR tornado_disabled = 0)`,
    `(tornado_day IS NULL OR tornado_day < 30)`,
    `(tornado_last_sent IS NULL OR tornado_last_sent < NOW() - INTERVAL '23 hours')`,
    // anti-collision: don't TORNADO a user who got a warmup message in the last 20h
    `(last_warmup_sent_at IS NULL OR last_warmup_sent_at < NOW() - INTERVAL '20 hours')`,
    `last_active <= NOW() - INTERVAL '7 days'`
  ];
  const params = [];
  if (Array.isArray(onlyTelegramIds) && onlyTelegramIds.length > 0) {
    params.push(onlyTelegramIds);
    // override the inactivity gate when explicitly targeting users (test mode)
    whereParts[whereParts.length - 1] = `1=1`;
    whereParts.push(`telegram_id = ANY($${params.length}::bigint[])`);
  }
  const sql = `
    SELECT * FROM users
    WHERE ${whereParts.join(' AND ')}
    ORDER BY last_active ASC
    LIMIT ${safeLimit}
  `;

  let result;
  try {
    result = await pool.query(sql, params);
  } catch (e) {
    console.error(`🌪️ TORNADO[${source}] SQL error:`, e.message);
    return { sent: 0, failed: 0, candidates: 0, considered: 0, blocked: 0, skipped: 0, error: e.message };
  }

  const candidates = result.rows;
  console.log(`🌪️ TORNADO[${source}]: ${candidates.length} candidates (limit=${safeLimit}, dryRun=${dryRun})`);

  // ---- DRY RUN: just describe what would happen, never write or send ----
  if (dryRun) {
    const details = candidates.map(u => ({
      telegram_id: Number(u.telegram_id),
      first_name: u.first_name || null,
      username: u.username || null,
      funnel_stage: u.funnel_stage,
      booking_status: u.booking_status,
      tornado_day_current: u.tornado_day || 0,
      tornado_day_next: (u.tornado_day || 0) + 1,
      last_active: u.last_active,
      last_warmup_sent_at: u.last_warmup_sent_at
    }));
    console.log(`🌪️ TORNADO[${source}] DRY RUN candidates:`, JSON.stringify(details.slice(0, 10)));
    return {
      dryRun: true,
      candidates: candidates.length,
      considered: candidates.length,
      sent: 0, failed: 0, blocked: 0, skipped: 0,
      details
    };
  }

  let sent = 0, failed = 0, blocked = 0, skipped = 0;
  const details = [];

  for (const user of candidates) {
    const currentDay = user.tornado_day || 0;
    const nextDay = currentDay + 1;
    const msg = TORNADO_MESSAGES[nextDay - 1];
    if (!msg) { skipped++; continue; }

    const keyboard = {
      inline_keyboard: [
        [{ text: msg.button, url: msg.url }],
        [{ text: '🛑 Не беспокоить', callback_data: 'tornado_stop' }]
      ]
    };

    // Resolve image path safely. msg.image is stored as '/public/tornado-images/day_XX.png'
    // and lives at <repo>/public/tornado-images/day_XX.png on disk.
    const imgPath = path.resolve(__dirname, '..', String(msg.image || '').replace(/^\//, ''));
    const hasImage = msg.image && fs.existsSync(imgPath);

    let sendRes;
    if (hasImage) {
      sendRes = await sendSafe('sendPhoto', user.telegram_id, imgPath, {
        caption: msg.text,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      // Telegram occasionally rejects photo sends with cryptic 400s; fall back to text
      if (!sendRes.ok && sendRes.error !== 'blocked') {
        console.warn(`🌪️ TORNADO photo failed for ${user.telegram_id}, falling back to text: ${sendRes.error}`);
        sendRes = await sendSafe('sendMessage', user.telegram_id, msg.text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
        // If markdown is the culprit, plain-text rescue
        if (!sendRes.ok && sendRes.error !== 'blocked' && /parse|entities/i.test(sendRes.error || '')) {
          sendRes = await sendSafe('sendMessage', user.telegram_id, msg.text, {
            reply_markup: keyboard
          });
        }
      }
    } else {
      if (msg.image) console.warn(`🌪️ TORNADO image missing on disk: ${imgPath}, sending text only`);
      sendRes = await sendSafe('sendMessage', user.telegram_id, msg.text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      if (!sendRes.ok && sendRes.error !== 'blocked' && /parse|entities/i.test(sendRes.error || '')) {
        sendRes = await sendSafe('sendMessage', user.telegram_id, msg.text, {
          reply_markup: keyboard
        });
      }
    }

    const errMsg = sendRes.error || '';
    const isBlocked = sendRes.error === 'blocked';
    const isChatNotFound = /chat not found/i.test(errMsg);
    // Only advance the day counter on success OR terminal/permanent failures
    // (so a transient 400 doesn't burn day-1 content for a user we'll keep retrying).
    const advanceDay = sendRes.ok || isBlocked || isChatNotFound;

    if (advanceDay) {
      await pool.query(
        `UPDATE users SET tornado_day = $1, tornado_last_sent = NOW() WHERE telegram_id = $2`,
        [nextDay, user.telegram_id]
      );
    } else {
      // Stamp last_sent to respect 23h dedup window even on soft failure,
      // but keep tornado_day as-is so the same content retries tomorrow.
      await pool.query(
        `UPDATE users SET tornado_last_sent = NOW() WHERE telegram_id = $1`,
        [user.telegram_id]
      );
    }

    if (isBlocked) {
      blocked++;
      // sendSafe → handleBlockedUser already disabled warmup. Also disable TORNADO.
      await pool.query(
        `UPDATE users SET tornado_disabled = 1 WHERE telegram_id = $1`,
        [user.telegram_id]
      );
      await logEvent('tornado_blocked', user.telegram_id, { day: nextDay });
      details.push({ telegram_id: Number(user.telegram_id), day: nextDay, status: 'blocked' });
      console.log(`🚫 TORNADO Day ${nextDay} → ${user.telegram_id} BLOCKED`);
    } else if (sendRes.ok) {
      sent++;
      await logEvent('tornado_sent', user.telegram_id, { day: nextDay, source });
      details.push({ telegram_id: Number(user.telegram_id), day: nextDay, status: 'sent' });
      console.log(`✅ TORNADO Day ${nextDay} → ${user.telegram_id} (${source})`);
    } else {
      failed++;
      await logEvent('tornado_failed', user.telegram_id, { day: nextDay, error: errMsg.slice(0, 200) });
      details.push({ telegram_id: Number(user.telegram_id), day: nextDay, status: 'failed', error: errMsg.slice(0, 120) });
      console.warn(`❌ TORNADO Day ${nextDay} → ${user.telegram_id} failed: ${errMsg}`);
    }

    await sleep(700); // ≥500ms per Telegram global rate-limit guidance
  }

  const stats = { source, candidates: candidates.length, considered: candidates.length, sent, failed, blocked, skipped, dryRun: false };
  console.log(`✅ TORNADO[${source}] done:`, JSON.stringify(stats));
  await logEvent('tornado_run_done', null, stats);
  return { ...stats, details };
}

// ============================================================
// EXIT SURVEY SENDER
// ============================================================
async function sendExitSurvey(telegramId) {
  if (!bot) return;
  try {
    const keyboard = EXIT_SURVEY_OPTIONS.map(opt => [{
      text: opt.text,
      callback_data: opt.callback
    }]);
    await bot.sendMessage(telegramId, EXIT_SURVEY_TEXT, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    await logEvent('exit_survey_sent', telegramId, {});
  } catch (err) {
    console.error(`Exit survey error for ${telegramId}:`, err.message);
    await handleBlockedUser(telegramId, err);
  }
}

// ============================================================
// BROADCAST: Helpers — image URL normalization + validation
// ============================================================

/**
 * Try to extract a direct image URL from an HTML share-page.
 * Looks at <meta property="og:image"> first, then twitter:image.
 * Used for hosts that hand out share URLs by default (ibb.co,
 * postimg.cc, etc.) where the URL the admin pastes returns HTML.
 */
async function extractOgImage(url, timeoutMs = 5000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 AltynBot/1.0' }
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('xhtml')) return null;
    const html = (await res.text()).slice(0, 200_000); // cap
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    return m && m[1] ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * Normalize public image URLs that Telegram cannot fetch as-is.
 * The most common admin mistakes:
 *   1) Google Drive view page  →  uc?export=download direct
 *   2) ibb.co / postimg share  →  resolve via og:image
 *   3) imgur.com/<id>          →  i.imgur.com/<id>.jpg
 * Returns the original URL when nothing to fix (or async-resolved one).
 *
 * NOTE: async because for HTML-share hosts we need to fetch the page once.
 *       The result is cached in the broadcasts table on the first send.
 */
async function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // ----- Google Drive -----
  let m = trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  m = trimmed.match(/drive\.google\.com\/open\?(?:.*&)?id=([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;

  // ----- ImageBB / Postimg / similar HTML-share hosts -----
  // Direct (i.ibb.co/..., i.postimg.cc/...) → keep as-is
  // Share page (ibb.co/<code>, postimg.cc/<code>) → resolve via og:image
  const shareHosts = [
    /^https?:\/\/(?:www\.)?ibb\.co\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i,
    /^https?:\/\/(?:www\.)?postimg\.cc\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i,
    /^https?:\/\/(?:www\.)?freeimage\.host\/i\/[A-Za-z0-9._-]+/i
  ];
  if (shareHosts.some(rx => rx.test(trimmed))) {
    const og = await extractOgImage(trimmed);
    if (og) return og;
  }

  // ----- Imgur single image short URL -----
  m = trimmed.match(/^https?:\/\/(?:www\.)?imgur\.com\/(?!a\/|gallery\/)([a-zA-Z0-9]+)\/?$/);
  if (m) return `https://i.imgur.com/${m[1]}.jpg`;

  return trimmed;
}

/**
 * HEAD-check (with GET fallback for hosts that 405/403 HEAD) that the URL
 * actually returns an image. Used as pre-flight before mass-broadcast so
 * one bad image URL doesn't kill all ~5000 sends with 100% failed_count.
 * Returns { ok, reason?, contentType?, finalUrl? }.
 */
async function checkImageUrl(url, timeoutMs = 7000) {
  if (!url) return { ok: false, reason: 'empty_url' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    } catch (e) {
      // Some CDNs reject HEAD — retry GET with Range header (cheap)
      res = await fetch(url, {
        method: 'GET', redirect: 'follow', signal: controller.signal,
        headers: { 'Range': 'bytes=0-2047' }
      });
    }
    if (!res.ok && res.status !== 206) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return { ok: false, reason: `not an image (Content-Type: ${ct || 'unknown'})` };
    return { ok: true, contentType: ct, finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

// Build the inline keyboard for broadcast messages — extracted so test mode
// uses the exact same keyboard the mass send will use.
function buildBroadcastKeyboard(buttonsJson) {
  let buttons = null;
  try { if (buttonsJson) buttons = JSON.parse(buttonsJson); } catch (e) {}
  return buttons && buttons.length > 0 ? {
    inline_keyboard: buttons.map(b => [{
      text: b.text,
      ...(b.url ? { url: b.url } : { callback_data: b.callback || 'book_diagnostic' })
    }])
  } : {
    inline_keyboard: [
      [{ text: '📝 Записаться', callback_data: 'book_diagnostic' }]
    ]
  };
}

/**
 * Send the broadcast to a SINGLE chat id — used by the admin "🧪 Test on me"
 * button to verify content + image + buttons before hitting the real list.
 * Returns { ok, error?, image_url_used?, image_warning? }.
 */
export async function sendBroadcastToChat(broadcastId, chatId) {
  if (!bot) return { ok: false, error: 'bot_not_initialized' };

  const r = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [broadcastId]);
  const broadcast = r.rows[0];
  if (!broadcast) return { ok: false, error: 'broadcast_not_found' };
  if (!chatId) return { ok: false, error: 'chat_id_required' };

  const keyboard = buildBroadcastKeyboard(broadcast.buttons);
  const normalizedUrl = await normalizeImageUrl(broadcast.image_url);

  let imageWarning = null;
  let imageUrlUsed = normalizedUrl;
  if (normalizedUrl) {
    const check = await checkImageUrl(normalizedUrl);
    if (!check.ok) {
      imageWarning = `Картинка не отправлена: ${check.reason}`;
      imageUrlUsed = null;
    }
  }

  let sendRes;
  if (imageUrlUsed) {
    sendRes = await sendSafe('sendPhoto', chatId, imageUrlUsed, {
      caption: broadcast.content,
      reply_markup: keyboard
    });
    // If Telegram still rejects the image (e.g. >5MB / CDN redirect), retry text-only
    if (!sendRes.ok && /wrong type|web page content|file is too big|wrong file/i.test(sendRes.error || '')) {
      imageWarning = `Картинка отвергнута Telegram: ${sendRes.error}. Отправлен текст без картинки.`;
      sendRes = await sendSafe('sendMessage', chatId, broadcast.content, { reply_markup: keyboard });
    }
  } else {
    sendRes = await sendSafe('sendMessage', chatId, broadcast.content, { reply_markup: keyboard });
  }

  if (!sendRes.ok) {
    return { ok: false, error: sendRes.error || 'send_failed', image_warning: imageWarning };
  }
  return { ok: true, image_url_used: imageUrlUsed, image_warning: imageWarning };
}

// ============================================================
// SEND BROADCAST: Production-grade dispatcher
// ============================================================
export async function sendBroadcast(broadcastId) {
  if (!bot) {
    console.error(`❌ BROADCAST #${broadcastId} aborted: bot is not initialized`);
    await updateBroadcast(broadcastId, { status: 'error' });
    return { sent: 0, failed: 0, total: 0, blocked: 0, reason: 'bot_not_initialized' };
  }

  const broadcastResult = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [broadcastId]);
  const broadcast = broadcastResult.rows[0];
  if (!broadcast) {
    console.error(`❌ BROADCAST #${broadcastId} aborted: broadcast row not found`);
    return { sent: 0, failed: 0, total: 0, blocked: 0, reason: 'not_found' };
  }

  const users = await getBroadcastUsers(broadcast.segment);
  if (users.length === 0) {
    console.warn(`⚠️ BROADCAST #${broadcastId} segment="${broadcast.segment}" has 0 active recipients`);
    await updateBroadcast(broadcastId, {
      status: 'sent', sent_count: 0, failed_count: 0, sent_at: new Date().toISOString()
    });
    return { sent: 0, failed: 0, total: 0, blocked: 0, reason: 'no_recipients' };
  }

  // ---- Pre-flight: normalize + validate image URL ONCE (not per-user) ----
  const keyboard = buildBroadcastKeyboard(broadcast.buttons);
  const normalizedUrl = await normalizeImageUrl(broadcast.image_url);
  let imageUrlUsed = normalizedUrl;
  let imageWarning = null;

  if (normalizedUrl) {
    const check = await checkImageUrl(normalizedUrl);
    if (!check.ok) {
      imageWarning = `Image URL invalid (${check.reason}) — falling back to text-only for all recipients`;
      console.warn(`⚠️ BROADCAST #${broadcastId} ${imageWarning}`);
      imageUrlUsed = null;
    } else if (normalizedUrl !== broadcast.image_url) {
      console.log(`🔧 BROADCAST #${broadcastId} normalized image_url: ${broadcast.image_url} → ${normalizedUrl}`);
      // Persist normalised URL back so admin sees the cleaned-up version
      await pool.query('UPDATE broadcasts SET image_url = $1 WHERE id = $2', [normalizedUrl, broadcastId]);
    }
  }

  console.log(`📤 BROADCAST #${broadcastId} starting: segment="${broadcast.segment}", recipients=${users.length}, image=${imageUrlUsed ? 'yes' : 'no'}`);

  // ---- Per-user dispatch ----
  let sent = 0, failed = 0, blocked = 0;
  const errorsSample = []; // first 10 distinct errors so we can debug post-mortem

  for (const u of users) {
    const tid = u.telegram_id;
    if (!tid) { failed++; continue; }

    let sendRes;
    if (imageUrlUsed) {
      sendRes = await sendSafe('sendPhoto', tid, imageUrlUsed, {
        caption: broadcast.content,
        reply_markup: keyboard
      });
      // If first user trips a "wrong type/file too big" error → image is bad
      // for everyone; downgrade to text for the rest of this run.
      if (!sendRes.ok && sent === 0 && /wrong type|web page content|file is too big|wrong file/i.test(sendRes.error || '')) {
        console.warn(`⚠️ BROADCAST #${broadcastId} image rejected by Telegram (${sendRes.error}) — switching to text-only for remaining ${users.length - failed} recipients`);
        imageUrlUsed = null;
        imageWarning = `Картинка отвергнута Telegram (${sendRes.error}); отправлен только текст`;
        sendRes = await sendSafe('sendMessage', tid, broadcast.content, { reply_markup: keyboard });
      }
    } else {
      sendRes = await sendSafe('sendMessage', tid, broadcast.content, { reply_markup: keyboard });
    }

    if (sendRes.ok) {
      sent++;
    } else if (sendRes.error === 'blocked') {
      blocked++;
      failed++;
    } else {
      failed++;
      if (errorsSample.length < 10 && sendRes.error) {
        errorsSample.push({ tid, reason: sendRes.error });
      }
      console.warn(`  ❌ ${tid} → ${sendRes.error}`);
    }
    await sleep(120);
  }

  await updateBroadcast(broadcastId, {
    status: 'sent',
    sent_count: sent,
    failed_count: failed,
    sent_at: new Date().toISOString()
  });
  await logEvent('broadcast_sent', null, {
    id: broadcastId, sent, failed, blocked, total: users.length, image_warning: imageWarning, errors_sample: errorsSample
  });
  console.log(`📤 BROADCAST #${broadcastId} done: total=${users.length} sent=${sent} failed=${failed} blocked=${blocked}${imageWarning ? ' [' + imageWarning + ']' : ''}`);
  return { sent, failed, blocked, total: users.length, image_warning: imageWarning, errors_sample: errorsSample };
}

// Export bot getter for use in other modules
export function getBot() {
  return bot;
}

// Export bot setter for initialization
export function setBot(botInstance) {
  bot = botInstance;
}
