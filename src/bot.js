import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getUser, createUser, updateUser, logMessage, logEvent
} from './database.js';
import {
  WELCOME_TEXT, WELCOME_IMAGE, QUIZ_QUESTIONS, SCENARIO_RESULTS,
  RESULT_IMAGES, WARMUP_MESSAGES, FOLLOWUP_MESSAGES, BOOKING_CONFIRM_TEXT
} from './content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWNER_ID = process.env.OWNER_TELEGRAM_ID;

let bot;

export function initBot(token) {
  bot = new TelegramBot(token, { polling: true });

  // /start command
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1] ? match[1].trim() : '';

    // Parse UTM from start param
    let source = 'organic';
    let utm = {};
    if (param) {
      const parts = param.split('_');
      source = parts[0] || 'link';
      utm = { utm_source: parts[0], utm_medium: parts[1], utm_campaign: parts[2] };
    }

    const user = createUser({
      telegram_id: chatId,
      username: msg.from.username,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name,
      source
    });

    logEvent('start', chatId, { source, param });
    logMessage(chatId, 'in', 'command', '/start');

    // Reset quiz state for restart
    updateUser(chatId, {
      funnel_stage: 'started',
      quiz_answers: null,
      quiz_score: 0,
      scenario: null,
      warmup_day: 0,
      warmup_active: 1,
      booking_status: 'none',
      ...utm
    });

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

    // Notify owner
    if (OWNER_ID) {
      const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
      const uname = msg.from.username ? `@${msg.from.username}` : 'нет username';
      bot.sendMessage(OWNER_ID, `🆕 *Новый пользователь!*\n\n👤 ${name}\n📱 ${uname}\n📊 Источник: ${source}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  });

  // Callback queries (quiz, booking, etc.)
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    // Quiz start
    if (data === 'quiz_start') {
      logEvent('quiz_start', chatId, {});
      updateUser(chatId, { funnel_stage: 'quiz', quiz_answers: JSON.stringify([]) });
      await sendQuizQuestion(chatId, 0);
      return;
    }

    // Quiz answer
    if (data.startsWith('quiz_')) {
      const parts = data.split('_');
      if (parts[1] === 'start') return;
      const qIndex = parseInt(parts[1]);
      const aIndex = parseInt(parts[2]);

      const user = getUser(chatId);
      if (!user) return;

      let answers = [];
      try { answers = JSON.parse(user.quiz_answers || '[]'); } catch(e) { answers = []; }
      answers.push({ question: qIndex, answer: aIndex });
      updateUser(chatId, { quiz_answers: JSON.stringify(answers) });

      logMessage(chatId, 'in', 'quiz_answer', `Q${qIndex + 1}: option ${aIndex}`);

      // Next question or results
      if (qIndex + 1 < QUIZ_QUESTIONS.length) {
        await sendQuizQuestion(chatId, qIndex + 1);
      } else {
        await sendQuizResult(chatId, answers);
      }
      return;
    }

    // Book diagnostic
    if (data === 'book_diagnostic') {
      logEvent('book_start', chatId, {});
      updateUser(chatId, { funnel_stage: 'booking' });
      await bot.sendMessage(chatId, '📝 *Запись на бесплатную диагностику*\n\nКак вас зовут?', {
        parse_mode: 'Markdown',
        reply_markup: { force_reply: true }
      });
      return;
    }

    // Restart quiz
    if (data === 'restart_quiz') {
      updateUser(chatId, { quiz_answers: JSON.stringify([]), scenario: null, funnel_stage: 'quiz' });
      await sendQuizQuestion(chatId, 0);
      return;
    }

    // WhatsApp link
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

    // Instagram link
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

  // Handle text messages (for booking flow)
  bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return; // Skip commands
    if (!msg.reply_to_message) return; // Only process replies

    const chatId = msg.chat.id;
    const user = getUser(chatId);
    if (!user) return;

    const replyText = msg.reply_to_message.text || '';

    // Booking: Name
    if (user.funnel_stage === 'booking' && replyText.includes('Как вас зовут')) {
      updateUser(chatId, { booking_name: msg.text });
      await bot.sendMessage(chatId, '✍️ Отлично! Опишите кратко ваш запрос — с чем хотите поработать?', {
        reply_markup: { force_reply: true }
      });
      logMessage(chatId, 'in', 'booking_name', msg.text);
      return;
    }

    // Booking: Request
    if (user.funnel_stage === 'booking' && (replyText.includes('Опишите кратко') || replyText.includes('запрос'))) {
      updateUser(chatId, { booking_request: msg.text });
      await bot.sendMessage(chatId, '📅 Когда вам удобно? Напишите желаемую дату и время (например: «Среда, 18:00»)', {
        reply_markup: { force_reply: true }
      });
      logMessage(chatId, 'in', 'booking_request', msg.text);
      return;
    }

    // Booking: Time
    if (user.funnel_stage === 'booking' && (replyText.includes('Когда вам удобно') || replyText.includes('дату и время'))) {
      updateUser(chatId, {
        booking_time: msg.text,
        booking_status: 'booked',
        funnel_stage: 'booked'
      });

      const updatedUser = getUser(chatId);
      const name = updatedUser.booking_name || updatedUser.first_name || 'друг';

      await bot.sendMessage(chatId, BOOKING_CONFIRM_TEXT(name), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }],
            [{ text: '📸 Instagram', callback_data: 'instagram' }],
            [{ text: '🌐 Сайт', url: 'https://altyn-therapy.pages.dev' }]
          ]
        }
      });

      logMessage(chatId, 'in', 'booking_time', msg.text);
      logEvent('booking_complete', chatId, { name, request: updatedUser.booking_request, time: msg.text });

      // Notify owner with full details
      if (OWNER_ID) {
        const scenario = updatedUser.scenario || 'не определён';
        const uname = updatedUser.username ? `@${updatedUser.username}` : 'нет username';
        const ownerMsg = `🔥 *НОВАЯ ЗАЯВКА НА ДИАГНОСТИКУ!*\n\n` +
          `👤 *Имя:* ${updatedUser.booking_name}\n` +
          `📱 *Telegram:* ${uname}\n` +
          `🆔 *ID:* \`${chatId}\`\n` +
          `🎭 *Сценарий:* ${scenario}\n` +
          `📝 *Запрос:* ${updatedUser.booking_request}\n` +
          `📅 *Время:* ${msg.text}\n\n` +
          `Напишите клиенту: tg://user?id=${chatId}`;

        bot.sendMessage(OWNER_ID, ownerMsg, { parse_mode: 'Markdown' }).catch(() => {});
      }

      // Stop warmup
      updateUser(chatId, { warmup_active: 0 });
      return;
    }
  });

  // Help command
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `🔮 *Алтын | Гипнотерапевт*\n\nКоманды:\n/start — Начать заново\n/quiz — Пройти тест\n/book — Записаться на диагностику\n/about — О гипнотерапии\n/contact — Контакты`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/quiz/, (msg) => {
    updateUser(msg.chat.id, { quiz_answers: JSON.stringify([]), scenario: null, funnel_stage: 'quiz' });
    sendQuizQuestion(msg.chat.id, 0);
  });

  bot.onText(/\/book/, (msg) => {
    updateUser(msg.chat.id, { funnel_stage: 'booking' });
    bot.sendMessage(msg.chat.id, '📝 *Запись на бесплатную диагностику*\n\nКак вас зовут?', {
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true }
    });
  });

  bot.onText(/\/about/, (msg) => {
    bot.sendMessage(msg.chat.id, `🧠 *Что такое гипнотерапия?*\n\nТерапевтический гипноз — это работа с бессознательным в состоянии глубокого расслабления.\n\n◇ Вы в сознании и всё контролируете\n◇ Это НЕ то, что показывают в кино\n◇ 8 сессий вместо лет обычной терапии\n◇ Работает с корнем проблемы, а не симптомами\n\n*Запросы:*\n• Повторяющиеся сценарии в отношениях\n• Финансовый потолок\n• Фоновая тревога\n• Синдром самозванца\n• Прокрастинация\n\n🌐 Подробнее: altyn-therapy.pages.dev`, {
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
    bot.sendMessage(msg.chat.id, `📞 *Контакты Алтын*\n\n💬 WhatsApp: +7 707 719 85 61\n📸 Instagram: @altyn.therapy\n🌐 Сайт: altyn-therapy.pages.dev`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 WhatsApp', url: 'https://wa.me/77077198561' }],
          [{ text: '📸 Instagram', url: 'https://instagram.com/altyn.therapy' }],
          [{ text: '🌐 Сайт', url: 'https://altyn-therapy.pages.dev' }]
        ]
      }
    });
  });

  console.log('🤖 Altyn Therapy Bot started');
  return bot;
}

async function sendQuizQuestion(chatId, index) {
  const q = QUIZ_QUESTIONS[index];
  const keyboard = q.options.map((opt, i) => [{
    text: opt.text,
    callback_data: `quiz_${index}_${i}`
  }]);

  await bot.sendMessage(chatId, q.text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });

  logMessage(chatId, 'out', 'quiz_question', `Question ${index + 1}`);
}

async function sendQuizResult(chatId, answers) {
  // Calculate scores
  const scores = { savior: 0, fear: 0, control: 0, freeze: 0 };

  answers.forEach(a => {
    const q = QUIZ_QUESTIONS[a.question];
    if (q && q.options[a.answer]) {
      const optScores = q.options[a.answer].scores;
      Object.entries(optScores).forEach(([key, val]) => {
        scores[key] = (scores[key] || 0) + val;
      });
    }
  });

  // Determine dominant scenario
  const scenario = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  const result = SCENARIO_RESULTS[scenario];

  updateUser(chatId, {
    scenario,
    quiz_score: Math.max(...Object.values(scores)),
    funnel_stage: 'quiz_completed'
  });

  logEvent('quiz_complete', chatId, { scenario, scores });

  // Send result image
  try {
    const imgPath = path.resolve(__dirname, '..', 'assets', `result_${result.image}.png`);
    if (fs.existsSync(imgPath)) {
      await bot.sendPhoto(chatId, imgPath);
    }
  } catch (err) {
    console.error('Error sending result image:', err.message);
  }

  // Send result text
  await bot.sendMessage(chatId, result.text, {
    parse_mode: 'Markdown'
  });

  // Send CTA
  await bot.sendMessage(chatId, result.cta, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Записаться на диагностику', callback_data: 'book_diagnostic' }],
        [{ text: '💬 Написать в WhatsApp', url: 'https://wa.me/77077198561' }],
        [{ text: '🔄 Пройти тест заново', callback_data: 'restart_quiz' }]
      ]
    }
  });

  logMessage(chatId, 'out', 'quiz_result', `Scenario: ${scenario}`);

  // Notify owner
  if (OWNER_ID) {
    const user = getUser(chatId);
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const uname = user.username ? `@${user.username}` : 'нет username';
    bot.sendMessage(OWNER_ID, `🎯 *Квиз пройден!*\n\n👤 ${name} (${uname})\n🎭 Сценарий: *${result.title}*\n📊 Баллы: ${JSON.stringify(scores)}`, { parse_mode: 'Markdown' }).catch(() => {});
  }

  // Start warmup
  updateUser(chatId, { warmup_active: 1, warmup_day: 0 });
}

// Warmup sender (called by cron)
export async function sendWarmupMessages() {
  if (!bot) return;

  const { getAllUsers } = await import('./database.js');
  const users = getAllUsers({ funnel_stage: 'quiz_completed' });

  for (const user of users) {
    if (!user.warmup_active || user.booking_status === 'booked') continue;

    const nextDay = (user.warmup_day || 0) + 1;
    const warmupMsg = WARMUP_MESSAGES.find(m => m.day === nextDay);
    const followupMsg = FOLLOWUP_MESSAGES.find(m => m.day === nextDay);

    const msgToSend = warmupMsg || followupMsg;
    if (!msgToSend) {
      if (nextDay > 14) updateUser(user.telegram_id, { warmup_active: 0 });
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

      updateUser(user.telegram_id, { warmup_day: nextDay });
      logMessage(user.telegram_id, 'out', 'warmup', `Day ${nextDay}`);
      logEvent('warmup_sent', user.telegram_id, { day: nextDay });
    } catch (err) {
      console.error(`Warmup error for ${user.telegram_id}:`, err.message);
      if (err.response && err.response.statusCode === 403) {
        updateUser(user.telegram_id, { warmup_active: 0 });
      }
    }

    // Small delay between messages
    await new Promise(r => setTimeout(r, 100));
  }
}

// Broadcast sender
export async function sendBroadcast(broadcastId) {
  if (!bot) return { sent: 0, failed: 0 };

  const { getBroadcastUsers, updateBroadcast } = await import('./database.js');
  const db = (await import('./database.js')).default;
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  if (!broadcast) return { sent: 0, failed: 0 };

  const users = getBroadcastUsers(broadcast.segment);
  let sent = 0, failed = 0;

  for (const u of users) {
    try {
      if (broadcast.image_url) {
        await bot.sendPhoto(u.telegram_id, broadcast.image_url, {
          caption: broadcast.content,
          parse_mode: 'Markdown'
        });
      } else {
        await bot.sendMessage(u.telegram_id, broadcast.content, {
          parse_mode: 'Markdown'
        });
      }
      sent++;
    } catch (err) {
      failed++;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  updateBroadcast(broadcastId, {
    status: 'sent',
    sent_count: sent,
    failed_count: failed,
    sent_at: new Date().toISOString()
  });

  return { sent, failed };
}

export function getBot() {
  return bot;
}
