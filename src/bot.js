import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getUser, createUser, updateUser, logMessage, logEvent,
  getAllUsers, getScheduledBroadcasts, updateBroadcast,
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

async function notifyAdmin(text, options = {}) {
  if (!bot) return;
  const targets = [];
  if (GROUP_ID) targets.push(GROUP_ID);
  if (OWNER_ID && OWNER_ID !== GROUP_ID) targets.push(OWNER_ID);
  for (const target of targets) {
    try {
      await bot.sendMessage(target, text, { parse_mode: 'Markdown', ...options });
    } catch (e) {
      console.error(`Notify error for ${target}:`, e.message);
    }
  }
}

let bot;

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
          bot.sendMessage(referrer.telegram_id, REFERRAL_NOTIFY(referrer.first_name, newName), {
            parse_mode: 'Markdown'
          }).catch(() => {});
        }
      } catch (e) {
        console.error('Referral tracking error:', e.message);
      }
    }

    // Send welcome image + text
    try {
      const imgPath = path.resolve(__dirname, '..', 'assets', 'welcome.png');
      if (fs.existsSync(imgPath)) {
        await bot.sendPhoto(chatId, imgPath, {
          caption: WELCOME_TEXT,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔮 Пройти тест', callback_data: 'quiz_start' }
            ]]
          }
        });
      } else {
        await bot.sendMessage(chatId, WELCOME_TEXT, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔮 Пройти тест', callback_data: 'quiz_start' }
            ]]
          }
        });
      }
    } catch (err) {
      console.error('Error sending welcome:', err.message);
      await bot.sendMessage(chatId, WELCOME_TEXT, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔮 Пройти тест', callback_data: 'quiz_start' }
          ]]
        }
      });
    }

    await logMessage(chatId, 'out', 'welcome', 'Welcome message sent');
    console.log(`✅ /start completed for ${chatId}`);

    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    const uname = msg.from.username ? `@${msg.from.username}` : 'нет username';
    notifyAdmin(
      `🆕 *Новый пользователь!*\n\n👤 ${name}\n📱 ${uname}\n🆔 \`${chatId}\`\n📊 Источник: ${source}${referrerId ? `\n🔗 Реферал от: ${referrerId}` : ''}`
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
      await updateUser(chatId, { funnel_stage: 'quiz', quiz_answers: JSON.stringify([]) });
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
      await updateUser(chatId, { funnel_stage: 'quiz', quiz_answers: JSON.stringify([]) });
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
        booking_time: null
      });
      await removeKeyboard(chatId, messageId);
      const name = user?.first_name || '';
      await bot.sendMessage(chatId, `📝 *Запись на бесплатную диагностику*\n\n${name ? `${name}, к` : 'К'}ак вас зовут? (Имя и фамилия)`, {
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
        await bot.sendMessage(chatId, `✍️ *${user.booking_name}*, опишите кратко ваш запрос — с чем хотите поработать?`, { parse_mode: 'Markdown' });
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
      await updateUser(targetId, { 
        booking_status: 'confirmed',
        session_completed_at: new Date().toISOString()
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
        `UPDATE users SET tornado_day = 30, exit_reason = 'tornado_stop' WHERE telegram_id = $1`,
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
        await bot.sendMessage(chatId, `✍️ Приятно познакомиться, *${nameInput}*!\n\nОпишите кратко ваш запрос — с чем хотите поработать?`, {
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
        await bot.sendMessage(chatId, BOOKING_CONFIRM_TEXT(name), {
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
          `👤 *Имя:* ${updatedUser.booking_name}\n` +
          `📱 *Telegram:* ${uname}\n` +
          `🆔 *ID:* \`${chatId}\`\n` +
          `🎭 *Сценарий:* ${scenarioTitle}\n` +
          `📝 *Запрос:* ${updatedUser.booking_request}\n` +
          `📅 *Время:* ${msg.text}\n` +
          `📊 *Источник:* ${updatedUser.source || 'organic'}\n` +
          `${updatedUser.utm_campaign ? `📎 *Кампания:* ${updatedUser.utm_campaign}\n` : ''}` +
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
    await updateUser(chatId, { funnel_stage: 'quiz', quiz_answers: JSON.stringify([]) });
    await sendQuizQuestion(chatId, 0);
  });

  bot.onText(/\/book/, async (msg) => {
    const chatId = msg.chat.id;
    await updateUser(chatId, {
      funnel_stage: 'booking',
      booking_name: null,
      booking_request: null,
      booking_time: null
    });
    const user = await getUser(chatId);
    const name = user?.first_name || '';
    await bot.sendMessage(chatId, `📝 *Запись на бесплатную диагностику*\n\n${name ? `${name}, к` : 'К'}ак вас зовут? (Имя и фамилия)`, {
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

  console.log('🤖 Altyn Therapy Bot v4.7.0 started');
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
    warmup_day: 0
  });
  await logEvent('quiz_completed', chatId, { scenario, scores });
  await logMessage(chatId, 'out', 'quiz_result', scenario);

  // Send result image
  try {
    const imgKey = result.image || scenario;
    const imgPath = path.resolve(__dirname, '..', 'assets', `result_${imgKey}.png`);
    if (fs.existsSync(imgPath)) {
      await bot.sendPhoto(chatId, imgPath, {
        caption: result.text,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, result.text, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Error sending result image:', err.message);
    await bot.sendMessage(chatId, result.text, { parse_mode: 'Markdown' });
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
    `👤 *Имя:* ${user?.first_name || 'Аноним'} ${user?.last_name || ''}`.trim() + `\n` +
    `📱 *Telegram:* ${uname}\n` +
    `🆔 *ID:* \`${chatId}\`\n` +
    `${scenarioEmoji} *Сценарий:* ${scenarioTitle}\n` +
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
// ============================================================
export async function sendWarmupMessages() {
  if (!bot) return;
  const users = await getAllUsers({});

  for (const user of users) {
    if (!user.warmup_active) continue;
    if (['booked', 'confirmed', 'completed'].includes(user.booking_status)) {
      await updateUser(user.telegram_id, { warmup_active: 0 }, true);
      continue;
    }
    // FIX v4.7.0: User must have completed quiz to get warmup messages
    if (user.funnel_stage !== 'quiz_completed') continue;

    const nextDay = (user.warmup_day || 0) + 1;
    const scenario = user.scenario;

    let msgToSend = null;
    if (scenario && SCENARIO_WARMUPS[scenario]) {
      msgToSend = SCENARIO_WARMUPS[scenario].find(m => m.day === nextDay);
    }
    if (!msgToSend) {
      msgToSend = WARMUP_MESSAGES.find(m => m.day === nextDay);
    }
    if (!msgToSend) {
      msgToSend = FOLLOWUP_MESSAGES.find(m => m.day === nextDay);
    }
    if (!msgToSend) {
      if (nextDay > 14) {
        if (!user.exit_reason) {
          await sendExitSurvey(user.telegram_id);
        }
        await updateUser(user.telegram_id, { warmup_active: 0 }, true);
      }
      continue;
    }

    try {
      const keyboard = nextDay >= 5 ? {
        inline_keyboard: [
          [{ text: '📝 Записаться на диагностику', callback_data: 'book_diagnostic' }],
          [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
        ]
      } : undefined;

      await bot.sendMessage(user.telegram_id, msgToSend.text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });

      // Send social proof on day 3 and day 6
      if ((nextDay === 3 || nextDay === 6) && scenario && TESTIMONIALS[scenario]) {
        const testimonials = TESTIMONIALS[scenario];
        const idx = nextDay === 3 ? 0 : (testimonials.length > 1 ? 1 : 0);
        await new Promise(r => setTimeout(r, 2000));
        await bot.sendMessage(user.telegram_id, testimonials[idx], { parse_mode: 'Markdown' });
      }

      await updateUser(user.telegram_id, { warmup_day: nextDay }, true);
      await logMessage(user.telegram_id, 'out', 'warmup', `Day ${nextDay} (${scenario || 'generic'})`);
      await logEvent('warmup_sent', user.telegram_id, { day: nextDay, scenario });
    } catch (err) {
      console.error(`Warmup error for ${user.telegram_id}:`, err.message);
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

// ============================================================
// REMINDER SENDER (called by cron - every 2 hours)
// ============================================================
export async function sendReminders() {
  if (!bot) return;

  // 1. Quiz reminders: users who started quiz 2h+ ago but didn't finish
  const quizStuckResult = await pool.query(`
    SELECT * FROM users
    WHERE funnel_stage = 'quiz'
    AND updated_at <= NOW() - INTERVAL '2 hours'
    AND updated_at >= NOW() - INTERVAL '24 hours'
    AND warmup_active = 1
  `);

  for (const user of quizStuckResult.rows) {
    try {
      let answers = [];
      try { answers = JSON.parse(user.quiz_answers || '[]'); } catch(e) {}
      const questionsLeft = QUIZ_QUESTIONS.length - answers.length;
      if (questionsLeft <= 0) continue;
      await bot.sendMessage(user.telegram_id, QUIZ_REMINDER_2H(questionsLeft), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '▶️ Продолжить тест', callback_data: 'continue_quiz' }],
            [{ text: '🔄 Начать заново', callback_data: 'restart_quiz' }]
          ]
        }
      });
      await logEvent('reminder_sent', user.telegram_id, { type: 'quiz_2h' });
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 2. Quiz reminders: users who started quiz 24h+ ago
  const quizAbandonedResult = await pool.query(`
    SELECT * FROM users
    WHERE funnel_stage = 'quiz'
    AND updated_at <= NOW() - INTERVAL '24 hours'
    AND updated_at >= NOW() - INTERVAL '48 hours'
    AND warmup_active = 1
  `);

  for (const user of quizAbandonedResult.rows) {
    try {
      await bot.sendMessage(user.telegram_id, QUIZ_REMINDER_24H, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔮 Пройти тест', callback_data: 'quiz_start' }]
          ]
        }
      });
      await logEvent('reminder_sent', user.telegram_id, { type: 'quiz_24h' });
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 3. Booking reminders: users who started booking but didn't finish (30 min)
  const bookingStuckResult = await pool.query(`
    SELECT * FROM users
    WHERE funnel_stage = 'booking'
    AND booking_status = 'none'
    AND updated_at <= NOW() - INTERVAL '30 minutes'
    AND updated_at >= NOW() - INTERVAL '2 hours'
  `);

  for (const user of bookingStuckResult.rows) {
    try {
      await bot.sendMessage(user.telegram_id, BOOKING_REMINDER_30MIN(user.booking_name || user.first_name), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Продолжить запись', callback_data: 'continue_booking' }],
            [{ text: '💬 Написать в WhatsApp', url: 'https://wa.me/77077198561' }]
          ]
        }
      });
      await logEvent('reminder_sent', user.telegram_id, { type: 'booking_30min' });
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 4. Booking reminders: users who started booking 24h+ ago but didn't finish
  const bookingAbandonedResult = await pool.query(`
    SELECT * FROM users
    WHERE funnel_stage = 'booking'
    AND booking_status = 'none'
    AND updated_at <= NOW() - INTERVAL '24 hours'
    AND updated_at >= NOW() - INTERVAL '48 hours'
  `);

  for (const user of bookingAbandonedResult.rows) {
    try {
      await bot.sendMessage(user.telegram_id, BOOKING_REMINDER_24H, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Записаться сейчас', callback_data: 'book_diagnostic' }],
            [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
          ]
        }
      });
      await logEvent('reminder_sent', user.telegram_id, { type: 'booking_24h' });
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 5. Follow-up after diagnostic: 1 day after booking confirmed — reminder about session
  const sessionReminderResult = await pool.query(`
    SELECT * FROM users
    WHERE booking_status = 'booked'
    AND booking_time IS NOT NULL
    AND updated_at <= NOW() - INTERVAL '20 hours'
    AND updated_at >= NOW() - INTERVAL '28 hours'
  `);

  for (const user of sessionReminderResult.rows) {
    try {
      const name = user.booking_name || user.first_name || 'друг';
      const time = user.booking_time || 'запланированное время';
      await bot.sendMessage(user.telegram_id,
        `🔔 *Напоминание о диагностике*\n\n${name}, напоминаю о нашей встрече!\n\n📅 *Время:* ${time}\n\nДиагностика пройдёт онлайн — ссылку я пришлю за 15 минут до начала.\n\nЕсли нужно перенести — напишите в WhatsApp, договоримся.\n\n_До встречи! 🙏\nАлтын, гипнотерапевт_`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Написать Алтын', url: 'https://wa.me/77077198561' }]
            ]
          }
        }
      );
      await logEvent('session_reminder_sent', user.telegram_id, { booking_time: time });
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 6. Reactivation: users who completed quiz but never booked, inactive 7+ days
  // FIX v4.7.1: Wider reactivation window (7-30 days) + dedup via reactivation_sent_at
  const reactivationResult = await pool.query(`
    SELECT * FROM users
    WHERE funnel_stage = 'quiz_completed'
    AND (booking_status IS NULL OR booking_status = 'none')
    AND exit_reason IS NULL
    AND last_active <= NOW() - INTERVAL '7 days'
    AND last_active >= NOW() - INTERVAL '30 days'
    AND (reactivation_sent_at IS NULL)
  `);

  for (const user of reactivationResult.rows) {
    try {
      const name = user.first_name || 'друг';
      const scenario = user.scenario || 'freeze';
      const scenarioEmoji = { savior: '🛡', fear: '💔', control: '🎯', freeze: '❄️' }[scenario] || '🎭';
      const scenarioNames = { savior: 'Спасатель', fear: 'Страх близости', control: 'Гиперконтроль', freeze: 'Заморозка' };
      const scenarioName = scenarioNames[scenario] || scenario;
      await bot.sendMessage(user.telegram_id,
        `${scenarioEmoji} *${name}, вы ещё думаете?*\n\nНеделю назад вы прошли тест и узнали свой сценарий — *«${scenarioName}»*.\n\nЯ понимаю: принять решение непросто. Но пока вы думаете, сценарий продолжает работать. Каждый день.\n\n*Вот что происходит в вашей психике:*\n◇ Сценарий автоматически повторяется в отношениях\n◇ Вы теряете возможности и деньги\n◇ Каждый день становится сложнее\n\n💬 Я предлагаю просто поговорить — 30 минут, бесплатно, без обязательств. На диагностике вы:\n◇ Поймёте корень проблемы\n◇ Почувствуете первые изменения\n◇ Узнаете план работы\n\nМест на этой неделе осталось немного. Запишитесь сейчас 👇`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Записаться на диагностику', callback_data: 'book_diagnostic' }],
              [{ text: '💬 Написать в WhatsApp', url: 'https://wa.me/77077198561' }]
            ]
          }
        }
      );
      await updateUser(user.telegram_id, { warmup_active: 1, warmup_day: 7 }, true);
      await pool.query('UPDATE users SET reactivation_sent_at = NOW() WHERE telegram_id = $1', [user.telegram_id]);
      await logEvent('reactivation_sent', user.telegram_id, { scenario, days_inactive: 7 });
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 7. Post-session follow-up: 2 days after session completed — offer next step
  // FIX v4.2.0: Use session_completed_at instead of updated_at for accurate follow-up timing
  // Only send if not already sent (post_session_followup_sent = 0)
  const postSessionResult = await pool.query(`
    SELECT * FROM users
    WHERE booking_status = 'confirmed'
    AND session_completed_at IS NOT NULL
    AND post_session_followup_sent = 0
    AND session_completed_at <= NOW() - INTERVAL '2 days'
    AND session_completed_at >= NOW() - INTERVAL '3 days'
  `);

  for (const user of postSessionResult.rows) {
    try {
      const name = user.booking_name || user.first_name || 'друг';
      await bot.sendMessage(user.telegram_id,
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
      await updateUser(user.telegram_id, { booking_status: 'completed', post_session_followup_sent: 1 }, true);
      await logEvent('post_session_followup_sent', user.telegram_id, { session_completed_at: user.session_completed_at });
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

// ============================================================
// 🌪️ TORNADO REACTIVATION — 30-дневная цепочка реактивации
// v4.3.0: Психологический шторм. Гладко, но убойно.
// ============================================================
export async function sendTornadoReactivation(botInstance, dbPool) {
  const b = botInstance || bot;
  if (!b) return;

  // Найти всех пользователей которые:
  // 1. Прошли квиз но не записались
  // 2. Неактивны 7+ дней
  // 3. Не заблокировали бота
  // 4. Не завершили ТОРНАДО (tornado_day < 30)
  // 5. Не получали сообщение сегодня
  const result = await pool.query(`
    SELECT * FROM users
    WHERE funnel_stage IN ('quiz_completed', 'warmup')
    AND (booking_status IS NULL OR booking_status = 'none')
    AND exit_reason IS NULL
    AND last_active <= NOW() - INTERVAL '7 days'
    AND (tornado_day IS NULL OR tornado_day < 30)
    AND (
      tornado_last_sent IS NULL
      OR tornado_last_sent < NOW() - INTERVAL '23 hours'
    )
    ORDER BY last_active ASC
    LIMIT 100
  `);

  console.log(`🌪️ TORNADO: Found ${result.rows.length} users to reactivate`);

  for (const user of result.rows) {
    const currentDay = (user.tornado_day || 0);
    const nextDay = currentDay + 1;
    const msg = TORNADO_MESSAGES[nextDay - 1];

    if (!msg) continue;

    try {
      // Отправляем картинку с текстом
      // FIX v4.7.1: Resolve image path relative to project root
      const imgPath = path.resolve(__dirname, '..', msg.image.replace(/^\//, ''));
      const photo = fs.existsSync(imgPath) ? imgPath : msg.image;
      await b.sendPhoto(user.telegram_id, photo, {
        caption: msg.text,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: msg.button, url: msg.url }],
            [{ text: '🛑 Не беспокоить', callback_data: 'tornado_stop' }]
          ]
        }
      });

      // Обновляем счётчик (не обновляем last_active при отправке ботом)
      await pool.query(
        `UPDATE users SET tornado_day = $1, tornado_last_sent = NOW() WHERE telegram_id = $2`,
        [nextDay, user.telegram_id]
      );

      await logEvent('tornado_sent', user.telegram_id, { day: nextDay });
      console.log(`✅ TORNADO Day ${nextDay} sent to ${user.telegram_id}`);
    } catch (err) {
      await handleBlockedUser(user.telegram_id, err);
    }

    // Пауза между отправками — не спамим Telegram API
    await new Promise(r => setTimeout(r, 300));
  }
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
// BROADCAST SENDER
// ============================================================
export async function sendBroadcast(broadcastId) {
  if (!bot) return { sent: 0, failed: 0 };

  const broadcastResult = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [broadcastId]);
  const broadcast = broadcastResult.rows[0];
  if (!broadcast) return { sent: 0, failed: 0 };

  const users = await getBroadcastUsers(broadcast.segment);
  let sent = 0, failed = 0;

  let buttons = null;
  try {
    if (broadcast.buttons) {
      buttons = JSON.parse(broadcast.buttons);
    }
  } catch(e) {}

  for (const u of users) {
    try {
      const keyboard = buttons && buttons.length > 0 ? {
        inline_keyboard: buttons.map(b => [{
          text: b.text,
          ...(b.url ? { url: b.url } : { callback_data: b.callback || 'book_diagnostic' })
        }])
      } : {
        inline_keyboard: [
          [{ text: '📝 Записаться', callback_data: 'book_diagnostic' }]
        ]
      };

      if (broadcast.image_url) {
        await bot.sendPhoto(u.telegram_id, broadcast.image_url, {
          caption: broadcast.content,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } else {
        await bot.sendMessage(u.telegram_id, broadcast.content, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      }
      sent++;
    } catch (err) {
      failed++;
      await handleBlockedUser(u.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 50));
  }

  await updateBroadcast(broadcastId, {
    status: 'sent',
    sent_count: sent,
    failed_count: failed,
    sent_at: new Date().toISOString()
  });
  await logEvent('broadcast_sent', null, { id: broadcastId, sent, failed });
  return { sent, failed };
}

// Export bot getter for use in other modules
export function getBot() {
  return bot;
}

// Export bot setter for initialization
export function setBot(botInstance) {
  bot = botInstance;
}
