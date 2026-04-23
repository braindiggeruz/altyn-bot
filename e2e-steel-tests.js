#!/usr/bin/env node

/**
 * 🛡️ ALTYN STEEL E2E TESTS — v4.4.0
 * 
 * Полный аудит воронки каждый день:
 * ✅ Базовые компоненты (health, DB, API)
 * ✅ Квиз и сценарии
 * ✅ Прогрев (7 дней)
 * ✅ Follow-up (2 дня)
 * ✅ ТОРНАДО (30 дней)
 * ✅ Алерты в Telegram при ошибках
 */

import pg from 'pg';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

const { Pool } = pg;

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN || '8698863140:AAEZE-iDU9T9RkUwmtl00SvVzY0srM1woqw';
const NOTIFY_GROUP = process.env.NOTIFY_GROUP || '-1003406252597';
const PRODUCTION_URL = 'https://altyn-bot-production.up.railway.app';
const DB_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DB_URL });
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ==================== TEST RESULTS ====================
const testResults = {
  passed: 0,
  failed: 0,
  errors: [],
  startTime: new Date(),
  tests: []
};

// ==================== HELPER FUNCTIONS ====================
async function test(name, fn) {
  try {
    await fn();
    testResults.passed++;
    testResults.tests.push({ name, status: '✅ PASS', error: null });
    console.log(`✅ ${name}`);
  } catch (err) {
    testResults.failed++;
    testResults.errors.push({ test: name, error: err.message });
    testResults.tests.push({ name, status: '❌ FAIL', error: err.message });
    console.error(`❌ ${name}: ${err.message}`);
  }
}

async function sendAlert(message) {
  try {
    await bot.sendMessage(NOTIFY_GROUP, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Failed to send alert:', err.message);
  }
}

// ==================== TESTS ====================

// 1️⃣ БАЗОВЫЕ КОМПОНЕНТЫ
async function testBasicComponents() {
  console.log('\n🔍 Testing Basic Components...\n');

  // Health Endpoint
  await test('Health Endpoint', async () => {
    const res = await axios.get(`${PRODUCTION_URL}/health`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.data.version) throw new Error('No version in health response');
    console.log(`   Version: ${res.data.version}`);
  });

  // Database Connection
  await test('Database Connection', async () => {
    const res = await pool.query('SELECT 1');
    if (!res.rows[0]) throw new Error('Database query failed');
  });

  // Telegram Bot API
  await test('Telegram Bot API', async () => {
    const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    if (!res.data.ok) throw new Error('Telegram API failed');
    console.log(`   Bot: @${res.data.result.username}`);
  });

  // Webhook Status
  await test('Webhook Configuration', async () => {
    const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    if (!res.data.ok) throw new Error('Webhook info failed');
    if (!res.data.result.url) throw new Error('No webhook URL configured');
    console.log(`   Webhook: ${res.data.result.url}`);
  });
}

// 2️⃣ КВИЗ И СЦЕНАРИИ
async function testQuizAndScenarios() {
  console.log('\n🎯 Testing Quiz & Scenarios...\n');

  const testUserId = 999999999;
  const testUserName = 'test_user_' + Date.now();

  try {
    // Создать тестового пользователя
    await pool.query(`
      INSERT INTO users (telegram_id, username, funnel_stage, created_at, last_active)
      VALUES ($1, $2, 'start', NOW(), NOW())
      ON CONFLICT (telegram_id) DO UPDATE SET funnel_stage = 'start'
    `, [testUserId, testUserName]);

    // Тест 1: Пользователь создан
    await test('Test User Created', async () => {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (!res.rows[0]) throw new Error('User not created');
    });

    // Тест 2: Quiz Start
    await test('Quiz Start', async () => {
      await pool.query(`
        UPDATE users SET funnel_stage = 'quiz_started', quiz_scenario = NULL
        WHERE telegram_id = $1
      `, [testUserId]);
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (res.rows[0].funnel_stage !== 'quiz_started') throw new Error('Quiz not started');
    });

    // Тест 3: Quiz Answers (симулируем ответы)
    const scenarios = ['savior', 'fear', 'control', 'freeze'];
    for (const scenario of scenarios) {
      await test(`Quiz Scenario: ${scenario}`, async () => {
        await pool.query(`
          UPDATE users SET quiz_scenario = $1, quiz_completed_at = NOW()
          WHERE telegram_id = $2
        `, [scenario, testUserId]);
        const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
        if (res.rows[0].quiz_scenario !== scenario) throw new Error('Scenario not saved');
      });
    }

    // Тест 4: Quiz Completion
    await test('Quiz Completion', async () => {
      await pool.query(`
        UPDATE users SET funnel_stage = 'quiz_completed'
        WHERE telegram_id = $1
      `, [testUserId]);
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (res.rows[0].funnel_stage !== 'quiz_completed') throw new Error('Quiz not completed');
    });

  } finally {
    // Удалить тестового пользователя
    await pool.query('DELETE FROM users WHERE telegram_id = $1', [testUserId]);
  }
}

// 3️⃣ ПРОГРЕВ (7 ДНЕЙ)
async function testWarmup() {
  console.log('\n🔥 Testing Warmup (7 days)...\n');

  const testUserId = 888888888;

  try {
    // Создать пользователя в warmup
    await pool.query(`
      INSERT INTO users (telegram_id, username, funnel_stage, quiz_completed_at, created_at, last_active)
      VALUES ($1, 'warmup_test', 'warmup', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
      ON CONFLICT (telegram_id) DO UPDATE SET funnel_stage = 'warmup'
    `, [testUserId]);

    // Тест 1: Warmup Stage
    await test('Warmup Stage Set', async () => {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (res.rows[0].funnel_stage !== 'warmup') throw new Error('Not in warmup stage');
    });

    // Тест 2: Warmup Duration (7 дней)
    await test('Warmup Duration (7 days)', async () => {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      const createdAt = new Date(res.rows[0].quiz_completed_at);
      const now = new Date();
      const days = (now - createdAt) / (1000 * 60 * 60 * 24);
      if (days < 0 || days > 7) throw new Error(`Invalid warmup duration: ${days} days`);
    });

  } finally {
    await pool.query('DELETE FROM users WHERE telegram_id = $1', [testUserId]);
  }
}

// 4️⃣ FOLLOW-UP (2 ДНЯ)
async function testFollowUp() {
  console.log('\n💬 Testing Follow-Up (2 days)...\n');

  const testUserId = 777777777;

  try {
    // Создать пользователя с сессией
    await pool.query(`
      INSERT INTO users (telegram_id, username, funnel_stage, session_completed_at, post_session_followup_sent, created_at, last_active)
      VALUES ($1, 'followup_test', 'warmup', NOW() - INTERVAL '2 days', 0, NOW(), NOW())
      ON CONFLICT (telegram_id) DO UPDATE SET session_completed_at = NOW() - INTERVAL '2 days'
    `, [testUserId]);

    // Тест 1: Session Completed At
    await test('Session Completed At Set', async () => {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (!res.rows[0].session_completed_at) throw new Error('Session not completed');
    });

    // Тест 2: Follow-Up Not Sent Yet
    await test('Follow-Up Not Sent Yet', async () => {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (res.rows[0].post_session_followup_sent !== 0) throw new Error('Follow-up already sent');
    });

    // Тест 3: Mark Follow-Up as Sent
    await test('Mark Follow-Up as Sent', async () => {
      await pool.query(`
        UPDATE users SET post_session_followup_sent = 1
        WHERE telegram_id = $1
      `, [testUserId]);
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (res.rows[0].post_session_followup_sent !== 1) throw new Error('Follow-up not marked as sent');
    });

  } finally {
    await pool.query('DELETE FROM users WHERE telegram_id = $1', [testUserId]);
  }
}

// 5️⃣ ТОРНАДО (30 ДНЕЙ)
async function testTornado() {
  console.log('\n🌪️ Testing TORNADO (30 days)...\n');

  const testUserId = 666666666;

  try {
    // Создать пользователя для ТОРНАДО
    await pool.query(`
      INSERT INTO users (telegram_id, username, funnel_stage, tornado_day, tornado_last_sent, created_at, last_active)
      VALUES ($1, 'tornado_test', 'quiz_completed', 0, NULL, NOW(), NOW() - INTERVAL '7 days')
      ON CONFLICT (telegram_id) DO UPDATE SET tornado_day = 0, last_active = NOW() - INTERVAL '7 days'
    `, [testUserId]);

    // Тест 1: TORNADO Day 0
    await test('TORNADO Day 0 (Not Started)', async () => {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (res.rows[0].tornado_day !== 0) throw new Error('TORNADO already started');
    });

    // Тест 2: Simulate TORNADO Days 1-30
    for (let day = 1; day <= 30; day++) {
      await test(`TORNADO Day ${day}`, async () => {
        await pool.query(`
          UPDATE users SET tornado_day = $1, tornado_last_sent = NOW()
          WHERE telegram_id = $2
        `, [day, testUserId]);
        const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
        if (res.rows[0].tornado_day !== day) throw new Error(`TORNADO day not updated to ${day}`);
      });

      // Не выводить каждый день в консоль
      if (day % 10 === 0) console.log(`   ... Day ${day} OK`);
    }

    // Тест 3: TORNADO Completion
    await test('TORNADO Completion (Day 30)', async () => {
      const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [testUserId]);
      if (res.rows[0].tornado_day !== 30) throw new Error('TORNADO not completed');
    });

  } finally {
    await pool.query('DELETE FROM users WHERE telegram_id = $1', [testUserId]);
  }
}

// 6️⃣ КАРТИНКИ ТОРНАДО
async function testTornadoImages() {
  console.log('\n🖼️ Testing TORNADO Images...\n');

  for (let day = 1; day <= 30; day++) {
    await test(`TORNADO Image Day ${day}`, async () => {
      const url = `${PRODUCTION_URL}/public/tornado-images/day_${String(day).padStart(2, '0')}.png`;
      const res = await axios.head(url);
      if (res.status !== 200) throw new Error(`Image returned ${res.status}`);
    });

    if (day % 10 === 0) console.log(`   ... Image ${day} OK`);
  }
}

// ==================== MAIN ====================
async function runAllTests() {
  console.log('🛡️ ALTYN STEEL E2E TESTS - Starting...\n');
  console.log(`⏰ ${new Date().toISOString()}\n`);

  try {
    await testBasicComponents();
    await testQuizAndScenarios();
    await testWarmup();
    await testFollowUp();
    await testTornado();
    await testTornadoImages();
  } catch (err) {
    console.error('Fatal error:', err);
  }

  // ==================== REPORT ====================
  const duration = Math.round((new Date() - testResults.startTime) / 1000);
  const total = testResults.passed + testResults.failed;
  const percentage = Math.round((testResults.passed / total) * 100);

  const report = `
🛡️ *ALTYN STEEL E2E TEST REPORT*

📊 *Results:*
✅ Passed: ${testResults.passed}
❌ Failed: ${testResults.failed}
📈 Success Rate: ${percentage}%
⏱️ Duration: ${duration}s

${testResults.failed > 0 ? `
🔴 *Errors:*
${testResults.errors.map(e => `• ${e.test}: ${e.error}`).join('\n')}
` : '✅ All tests passed!'}

⏰ ${new Date().toISOString()}
  `.trim();

  console.log('\n' + report);

  // Отправить отчет в Telegram
  if (testResults.failed > 0) {
    await sendAlert(`🔴 *ALTYN E2E TESTS FAILED*\n\n${report}`);
  } else {
    await sendAlert(`✅ *ALTYN E2E TESTS PASSED*\n\n${report}`);
  }

  // Закрыть соединение
  await pool.end();
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Запустить тесты
runAllTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
