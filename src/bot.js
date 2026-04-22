import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getUser, createUser, updateUser, logMessage, logEvent
} from './database.js';
import {
  WELCOME_TEXT, WELCOME_IMAGE, QUIZ_QUESTIONS, SCENARIO_RESULTS,
  RESULT_IMAGES, WARMUP_MESSAGES, FOLLOWUP_MESSAGES, BOOKING_CONFIRM_TEXT,
  SCENARIO_WARMUPS, TESTIMONIALS, EXIT_SURVEY_TEXT, EXIT_SURVEY_OPTIONS,
  EXIT_FOLLOWUPS, QUIZ_REMINDER_2H, QUIZ_REMINDER_24H,
  BOOKING_REMINDER_30MIN, BOOKING_REMINDER_24H,
  REFERRAL_TEXT, REFERRAL_NOTIFY
} from './content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// NOTIFICATION TARGETS
// OWNER_TELEGRAM_ID — личный ID владельца (необязательно)
// NOTIFY_GROUP_ID   — ID группы "Алтын-заявки" (приоритет)
// ============================================================
const OWNER_ID = process.env.OWNER_TELEGRAM_ID || null;
const GROUP_ID = process.env.NOTIFY_GROUP_ID || null;

// Отправить уведомление в группу И/ИЛИ владельцу
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
  } catch(e) {
    // Message might be too old or already edited
  }
}

// ============================================================
// HELPER: Phone number validation
// ============================================================
function isValidPhone(text) {
  // Accepts: +7XXXXXXXXXX, 8XXXXXXXXXX, 87XXXXXXXXX, +998XXXXXXXXX, +7 777 123 45 67, etc.
  const cleaned = text.replace(/[\s\-\(\)\.]/g, '');
  // Kazakhstan: +7 or 8 followed by 10 digits, or just 10 digits starting with 7
  // Uzbekistan: +998 followed by 9 digits
  // Generic: any + followed by 10-14 digits
  return /^(\+?[78]\d{10}|\+?998\d{9}|\+\d{10,14}|\d{10,11})$/.test(cleaned);
}

// ============================================================
// HELPER: Safely disable warmup for blocked users
// ============================================================
function handleBlockedUser(telegramId, err) {
  if (
    (err.response && err.response.statusCode === 403) ||
    (err.code === 'ETELEGRAM' && err.message && err.message.includes('403'))
  ) {
    updateUser(telegramId, { warmup_active: 0 });
    console.log(`🚫 User ${telegramId} blocked bot — warmup disabled`);
    return true;
  }
  return false;
}

export function initBot(token) {
  bot = new TelegramBot(token, { polling: true });

  // /start command
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1] ? match[1].trim() : '';

    // Parse UTM or referral from start param
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

    createUser({
      telegram_id: chatId,
      username: msg.from.username,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name,
      source
    });

    logEvent('start', chatId, { source, param, referrerId });
    logMessage(chatId, 'in', 'command', '/start');

    // FIX: Don't reset booking data if user already booked/completed
    const existingUser = getUser(chatId);
    const alreadyBooked = existingUser && ['booked', 'confirmed', 'completed'].includes(existingUser.booking_status);
    
    if (alreadyBooked) {
      // Just update source/utm, don't reset booking
      updateUser(chatId, {
        last_active: new Date().toISOString(),
        referred_by: referrerId || undefined,
        ...utm
      });
    } else {
      // Reset quiz state for restart — also clear booking fields
      updateUser(chatId, {
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
        trackReferral(referrerId, chatId);
        const referrer = getUser(parseInt(referrerId));
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

    logMessage(chatId, 'out', 'welcome', 'Welcome message sent');

    // Notify admin group/owner about new user
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    const uname = msg.from.username ? `@${msg.from.username}` : 'нет username';
    notifyAdmin(
      `🆕 *Новый пользователь!*\n\n👤 ${name}\n📱 ${uname}\n🆔 \`${chatId}\`\n📊 Источник: ${source}${referrerId ? `\n🔗 Реферал от: ${referrerId}` : ''}`
    );
  });

  // ============================================================
  // CALLBACK QUERIES (quiz, booking, exit survey, referral, etc.)
  // ============================================================
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    // ---- Quiz start ----
    if (data === 'quiz_start') {
      logEvent('quiz_start', chatId, {});
      updateUser(chatId, { funnel_stage: 'quiz', quiz_answers: JSON.stringify([]) });
      // Remove "Пройти тест" button from welcome message
      await removeKeyboard(chatId, messageId);
      await sendTyping(chatId, 500);
      await sendQuizQuestion(chatId, 0);
      return;
    }

    // ---- Quiz answer ----
    if (data.startsWith('quiz_')) {
      const parts = data.split('_');
      if (parts[1] === 'start') return; // safety guard
      const qIndex = parseInt(parts[1]);
      const aIndex = parseInt(parts[2]);

      // Validate parsed values
      if (isNaN(qIndex) || isNaN(aIndex)) return;
      if (qIndex < 0 || qIndex >= QUIZ_QUESTIONS.length) return;
      if (aIndex < 0 || aIndex >= QUIZ_QUESTIONS[qIndex].options.length) return;

      const user = getUser(chatId);
      if (!user) return;

      let answers = [];
      try { answers = JSON.parse(user.quiz_answers || '[]'); } catch(e) { answers = []; }

      // *** FIX: Duplicate answer protection ***
      if (answers.some(a => a.question === qIndex)) {
        // Already answered this question — ignore duplicate click
        return;
      }

      answers.push({ question: qIndex, answer: aIndex });
      updateUser(chatId, { quiz_answers: JSON.stringify(answers) });

      // Remove buttons from the answered question
      await removeKeyboard(chatId, messageId);

      logMessage(chatId, 'in', 'quiz_answer', `Q${qIndex + 1}: option ${aIndex}`);

      // Next question or results
      if (qIndex + 1 < QUIZ_QUESTIONS.length) {
        await sendTyping(chatId, 600);
        await sendQuizQuestion(chatId, qIndex + 1);
      } else {
        await sendTyping(chatId, 1000);
        await sendQuizResult(chatId, answers);
      }
      return;
    }

    // ---- Book diagnostic ----
    if (data === 'book_diagnostic') {
      logEvent('book_start', chatId, {});
      // Clear previous booking data for fresh start
      updateUser(chatId, {
        funnel_stage: 'booking',
        booking_name: null,
        booking_request: null,
        booking_time: null
      });
      await removeKeyboard(chatId, messageId);
      await sendTyping(chatId, 500);
      
      const user = getUser(chatId);
      const name = user?.first_name || '';
      
      await bot.sendMessage(chatId, `📝 *Запись на бесплатную диагностику*\n\n${name ? `${name}, к` : 'К'}ак вас зовут? (Имя и фамилия)`, {
        parse_mode: 'Markdown'
      });
      return;
    }

    // ---- Restart quiz ----
    if (data === 'restart_quiz') {
      updateUser(chatId, { quiz_answers: JSON.stringify([]), scenario: null, funnel_stage: 'quiz' });
      await removeKeyboard(chatId, messageId);
      await sendTyping(chatId, 500);
      await sendQuizQuestion(chatId, 0);
      return;
    }

    // ---- Continue quiz (from reminder) ----
    if (data === 'continue_quiz') {
      const user = getUser(chatId);
      if (!user) return;
      let answers = [];
      try { answers = JSON.parse(user.quiz_answers || '[]'); } catch(e) { answers = []; }
      const nextQ = answers.length;
      await removeKeyboard(chatId, messageId);
      if (nextQ < QUIZ_QUESTIONS.length) {
        updateUser(chatId, { funnel_stage: 'quiz' });
        await sendTyping(chatId, 500);
        await sendQuizQuestion(chatId, nextQ);
      } else {
        await sendQuizResult(chatId, answers);
      }
      return;
    }

    // ---- Continue booking (from reminder) ----
    if (data === 'continue_booking') {
      updateUser(chatId, { funnel_stage: 'booking' });
      await removeKeyboard(chatId, messageId);
      const user = getUser(chatId);
      if (user && user.booking_name) {
        if (!user.booking_request) {
          await bot.sendMessage(chatId, '✍️ Отлично! Опишите кратко ваш запрос — с чем хотите поработать?');
        } else {
          await bot.sendMessage(chatId, '📅 Когда вам удобно? Напишите желаемую дату и время (например: «Среда, 18:00»)');
        }
      } else {
        await bot.sendMessage(chatId, '📝 *Запись на бесплатную диагностику*\n\nКак вас зовут? (Имя и фамилия)', {
          parse_mode: 'Markdown'
        });
      }
      return;
    }

    // ---- Confirm booking (owner/admin action) ----
    if (data.startsWith('confirm_booking_')) {
      const clientId = parseInt(data.replace('confirm_booking_', ''));
      if (isNaN(clientId)) return;
      
      updateUser(clientId, { booking_status: 'confirmed' });
      await removeKeyboard(chatId, messageId);
      await bot.sendMessage(chatId, `✅ Запись клиента подтверждена! Клиент получит уведомление.`);
      
      // Notify client
      try {
        await bot.sendMessage(clientId, '✅ *Отличная новость!*\n\nВаша запись на диагностическую сессию подтверждена. Ждём вас!\n\nЕсли нужно перенести — напишите в WhatsApp.', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
            ]
          }
        });
      } catch(e) {
        await bot.sendMessage(chatId, '⚠️ Не удалось уведомить клиента (возможно, заблокировал бота).');
      }
      
      logEvent('booking_confirmed', clientId, { confirmed_by: chatId });
      return;
    }

    // ---- Exit survey answers ----
    if (data.startsWith('exit_')) {
      logEvent('exit_survey', chatId, { reason: data });
      updateUser(chatId, { exit_reason: data });
      await removeKeyboard(chatId, messageId);

      const followups = EXIT_FOLLOWUPS[data];
      if (followups) {
        for (const text of followups) {
          await sendTyping(chatId, 500);
          await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: data !== 'exit_solved' && data !== 'exit_irrelevant' ? {
              inline_keyboard: [
                [{ text: '📝 Записаться на диагностику', callback_data: 'book_diagnostic' }],
                [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
              ]
            } : undefined
          });
        }
      }

      await bot.sendMessage(chatId, '🙏 Спасибо за ответ! Это поможет нам стать лучше.');
      logMessage(chatId, 'out', 'exit_followup', data);
      return;
    }

    // ---- Referral link request ----
    if (data === 'get_referral') {
      const user = getUser(chatId);
      if (!user) return;
      const refCode = chatId.toString();
      const { getReferralCount } = await import('./database.js');
      const count = getReferralCount(chatId);
      const text = REFERRAL_TEXT(refCode).replace('*0 человек*', `*${count} человек*`);
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      return;
    }

    // ---- WhatsApp link ----
    if (data === 'whatsapp') {
      await bot.sendMessage(chatId, '📱 Напишите мне в WhatsApp:\nhttps://wa.me/77077198561\n\nИли позвоните: +7 707 719 85 61', {
        reply_markup: {
          inline_keyboard: [[
            { text: '💬 Открыть WhatsApp', url: 'https://wa.me/77077198561' }
          ]]
        }
      });
      return;
    }

    // ---- Instagram link ----
    if (data === 'instagram') {
      await bot.sendMessage(chatId, '📸 Подписывайтесь на Instagram:\nhttps://instagram.com/altyn.therapy', {
        reply_markup: {
          inline_keyboard: [[
            { text: '📸 Открыть Instagram', url: 'https://instagram.com/altyn.therapy' }
          ]]
        }
      });
      return;
    }
  });

  // ============================================================
  // TEXT MESSAGES — State-machine booking flow (no force_reply needed!)
  // ============================================================
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;
    // Ignore messages from groups (except commands)
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return;

    const chatId = msg.chat.id;
    const user = getUser(chatId);
    if (!user) return;

    // ---- BOOKING FLOW: State machine approach ----
    if (user.funnel_stage === 'booking') {
      
      // Step 1: Waiting for name
      if (!user.booking_name) {
        const nameInput = msg.text.trim();
        // Basic name validation: at least 2 chars, no digits
        if (nameInput.length < 2) {
          await bot.sendMessage(chatId, '⚠️ Пожалуйста, введите ваше имя и фамилию.');
          return;
        }
        updateUser(chatId, { booking_name: nameInput });
        logMessage(chatId, 'in', 'booking_name', msg.text);
        await sendTyping(chatId, 500);
        await bot.sendMessage(chatId, `✍️ Приятно познакомиться, *${nameInput}*!\n\nОпишите кратко ваш запрос — с чем хотите поработать?`, {
          parse_mode: 'Markdown'
        });
        return;
      }

      // Step 2: Waiting for request description
      if (!user.booking_request) {
        updateUser(chatId, { booking_request: msg.text.trim() });
        logMessage(chatId, 'in', 'booking_request', msg.text);
        await sendTyping(chatId, 500);
        await bot.sendMessage(chatId, '📅 Когда вам удобно? Напишите желаемую дату и время\n\n_Например: «Среда, 18:00» или «Завтра после 15:00»_', {
          parse_mode: 'Markdown'
        });
        return;
      }

      // Step 3: Waiting for time
      if (!user.booking_time) {
        updateUser(chatId, {
          booking_time: msg.text.trim(),
          booking_status: 'booked',
          funnel_stage: 'booked'
        });

        const updatedUser = getUser(chatId);
        const name = updatedUser.booking_name || updatedUser.first_name || 'друг';

        logMessage(chatId, 'in', 'booking_time', msg.text);
        logEvent('booking_complete', chatId, { name, request: updatedUser.booking_request, time: msg.text });

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

        // Stop warmup
        updateUser(chatId, { warmup_active: 0 });
        return;
      }
    }

    // If not in booking flow — ignore non-command messages
  });

  // ============================================================
  // COMMANDS
  // ============================================================
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `🔮 *Алтын | Гипнотерапевт*\n\nКоманды:\n/start — Начать заново\n/quiz — Пройти тест\n/book — Записаться на диагностику\n/about — О гипнотерапии\n/contact — Контакты\n/referral — Реферальная ссылка`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/quiz/, (msg) => {
    updateUser(msg.chat.id, { quiz_answers: JSON.stringify([]), scenario: null, funnel_stage: 'quiz' });
    sendQuizQuestion(msg.chat.id, 0);
  });

  bot.onText(/\/book/, (msg) => {
    updateUser(msg.chat.id, {
      funnel_stage: 'booking',
      booking_name: null,
      booking_request: null,
      booking_time: null
    });
    bot.sendMessage(msg.chat.id, '📝 *Запись на бесплатную диагностику*\n\nКак вас зовут? (Имя и фамилия)', {
      parse_mode: 'Markdown'
    });
  });

  bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    const { getReferralCount } = await import('./database.js');
    const count = getReferralCount(chatId);
    const text = REFERRAL_TEXT(chatId.toString()).replace('*0 человек*', `*${count} человек*`);
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/about/, (msg) => {
    bot.sendMessage(msg.chat.id, `🧠 *Что такое гипнотерапия?*\n\nТерапевтический гипноз — это работа с бессознательным в состоянии глубокого расслабления.\n\n◇ Вы в сознании и всё контролируете\n◇ Это НЕ то, что показывают в кино\n◇ 8 сессий вместо лет обычной терапии\n◇ Работает с корнем проблемы, а не симптомами\n\n*Запросы:*\n• Повторяющиеся сценарии в отношениях\n• Финансовый потолок\n• Фоновая тревога\n• Синдром самозванца\n• Прокрастинация\n\n🌐 Подробнее: altyn-therapy.uz`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔮 Пройти тест', callback_data: 'quiz_start' },
          { text: '📝 Записаться', callback_data: 'book_diagnostic' }
        ]]
      }
    });
  });

  bot.onText(/\/contact/, (msg) => {
    bot.sendMessage(msg.chat.id, `📞 *Контакты Алтын*\n\n💬 WhatsApp: +7 707 719 85 61\n📸 Instagram: @altyn.therapy\n🌐 Сайт: altyn-therapy.uz`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }],
          [{ text: '📸 Instagram', url: 'https://instagram.com/altyn.therapy' }],
          [{ text: '🌐 Сайт', url: 'https://altyn-therapy.uz' }]
        ]
      }
    });
  });

  // Handle polling errors gracefully
  bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.response?.statusCode === 409) {
      console.error('⚠️ CONFLICT: Another bot instance is running with the same token!');
      console.error('⚠️ Only ONE instance should be running at a time.');
    } else if (err.code === 'ETELEGRAM' && err.response?.statusCode === 401) {
      console.error('❌ INVALID BOT TOKEN! Check BOT_TOKEN environment variable.');
    } else {
      console.error('Polling error:', err.code, err.message);
    }
  });

  console.log('🤖 Altyn Therapy Bot v2.2.0 started');
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

  await sendTyping(chatId, 400);
  await bot.sendMessage(chatId, `${q.text}\n\n_Прогресс: ${progress}_`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ============================================================
// QUIZ RESULT SENDER
// ============================================================
async function sendQuizResult(chatId, answers) {
  // Calculate scores
  const scores = { savior: 0, fear: 0, control: 0, freeze: 0 };
  for (const answer of answers) {
    const q = QUIZ_QUESTIONS[answer.question];
    if (!q) continue;
    const opt = q.options[answer.answer];
    if (!opt || !opt.scores) continue;
    for (const [key, val] of Object.entries(opt.scores)) {
      if (scores[key] !== undefined) scores[key] += val;
    }
  }

  // Determine dominant scenario
  const scenario = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  const result = SCENARIO_RESULTS[scenario];

  updateUser(chatId, {
    scenario,
    quiz_score: JSON.stringify(scores),
    funnel_stage: 'quiz_completed',
    warmup_active: 1,
    warmup_day: 0
  });

  logEvent('quiz_completed', chatId, { scenario, scores });
  logMessage(chatId, 'out', 'quiz_result', scenario);

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

  await new Promise(r => setTimeout(r, 1500));

  // Send CTA
  await bot.sendMessage(chatId, result.cta, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Записаться на бесплатную диагностику', callback_data: 'book_diagnostic' }],
        [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }]
      ]
    }
  });

  // Notify admin about quiz completion
  const user = getUser(chatId);
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'Аноним';
  const uname = user?.username ? `@${user.username}` : 'нет username';
  notifyAdmin(
    `🎯 *Квиз пройден!*\n\n👤 ${name} (${uname})\n🆔 \`${chatId}\`\n🎭 Сценарий: *${result.title}*\n📊 Баллы: ${JSON.stringify(scores)}`
  );

  // Start scenario-specific warmup
  updateUser(chatId, { warmup_active: 1, warmup_day: 0 });
}

// ============================================================
// WARMUP SENDER (called by cron - every day at 10:00 Almaty)
// ============================================================
export async function sendWarmupMessages() {
  if (!bot) return;
  const { getAllUsers } = await import('./database.js');
  const users = getAllUsers({});
  for (const user of users) {
    // FIX: Skip users who are already booked, confirmed or completed
    if (!user.warmup_active) continue;
    if (['booked', 'confirmed', 'completed'].includes(user.booking_status)) {
      updateUser(user.telegram_id, { warmup_active: 0 });
      continue;
    }
    if (!user.scenario && user.funnel_stage !== 'quiz_completed') continue;
    const nextDay = (user.warmup_day || 0) + 1;
    const scenario = user.scenario;
    // Get scenario-specific warmup or fallback to generic
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
        updateUser(user.telegram_id, { warmup_active: 0 });
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
      updateUser(user.telegram_id, { warmup_day: nextDay });
      logMessage(user.telegram_id, 'out', 'warmup', `Day ${nextDay} (${scenario || 'generic'})`);
      logEvent('warmup_sent', user.telegram_id, { day: nextDay, scenario });
    } catch (err) {
      console.error(`Warmup error for ${user.telegram_id}:`, err.message);
      handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

// ============================================================
// REMINDER SENDER (called by cron - every 2 hours)
// ============================================================
export async function sendReminders() {
  if (!bot) return;
  const db = (await import('./database.js')).default;
  // 1. Quiz reminders: users who started quiz but didn't finish (2h+ ago)
  const quizStuck = db.prepare(`
    SELECT * FROM users 
    WHERE funnel_stage = 'quiz' 
    AND quiz_answers IS NOT NULL 
    AND updated_at <= datetime('now', '-2 hours')
    AND updated_at >= datetime('now', '-24 hours')
    AND warmup_active = 1
  `).all();
  for (const user of quizStuck) {
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
      logEvent('reminder_sent', user.telegram_id, { type: 'quiz_2h' });
    } catch (err) {
      handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  // 2. Quiz reminders: users who started quiz 24h+ ago
  const quizAbandoned = db.prepare(`
    SELECT * FROM users 
    WHERE funnel_stage = 'quiz' 
    AND updated_at <= datetime('now', '-24 hours')
    AND updated_at >= datetime('now', '-48 hours')
    AND warmup_active = 1
  `).all();
  for (const user of quizAbandoned) {
    try {
      await bot.sendMessage(user.telegram_id, QUIZ_REMINDER_24H, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔮 Пройти тест', callback_data: 'quiz_start' }]
          ]
        }
      });
      logEvent('reminder_sent', user.telegram_id, { type: 'quiz_24h' });
    } catch (err) {
      handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  // 3. Booking reminders: users who started booking but didn't finish
  const bookingStuck = db.prepare(`
    SELECT * FROM users 
    WHERE funnel_stage = 'booking' 
    AND booking_status = 'none'
    AND updated_at <= datetime('now', '-30 minutes')
    AND updated_at >= datetime('now', '-24 hours')
  `).all();
  for (const user of bookingStuck) {
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
      logEvent('reminder_sent', user.telegram_id, { type: 'booking_30min' });
    } catch (err) {
      handleBlockedUser(user.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 100));
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
    logEvent('exit_survey_sent', telegramId, {});
  } catch (err) {
    console.error(`Exit survey error for ${telegramId}:`, err.message);
    handleBlockedUser(telegramId, err);
  }
}

// ============================================================
// BROADCAST SENDER
// ============================================================
export async function sendBroadcast(broadcastId) {
  if (!bot) return { sent: 0, failed: 0 };
  const { getBroadcastUsers, updateBroadcast } = await import('./database.js');
  const db = (await import('./database.js')).default;
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  if (!broadcast) return { sent: 0, failed: 0 };
  const users = getBroadcastUsers(broadcast.segment);
  let sent = 0, failed = 0;
  // Parse buttons if present
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
      handleBlockedUser(u.telegram_id, err);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  updateBroadcast(broadcastId, {
    status: 'sent',
    sent_count: sent,
    failed_count: failed,
    sent_at: new Date().toISOString()
  });
  logEvent('broadcast_sent', null, { id: broadcastId, sent, failed });
  return { sent, failed };
}

export function getBot() {
  return bot;
}
