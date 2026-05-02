#!/usr/bin/env node
/**
 * test-tornado.js — local CLI for safe TORNADO validation.
 *
 * Usage:
 *   node scripts/test-tornado.js --dry-run [--limit=N]
 *   node scripts/test-tornado.js --telegram-id=<ID>
 *   node scripts/test-tornado.js --limit=5
 *
 * Requires the same env vars as the main bot (DATABASE_URL, BOT_TOKEN).
 * Run from the repo root. Does NOT start the express server / cron jobs —
 * it only initialises the bot client and DB pool, fires one TORNADO pass,
 * and exits.
 */
import 'dotenv/config';

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
}

const dryRun = !!flags['dry-run'];
const limit = parseInt(flags.limit || (dryRun ? 100 : 5), 10);
const telegramId = flags['telegram-id'] ? parseInt(flags['telegram-id'], 10) : null;

(async () => {
  const { initBot, sendTornadoReactivation, setBot } = await import('../src/bot.js');
  const { initDatabase } = await import('../src/database.js');

  await initDatabase();

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is not set');
    process.exit(2);
  }

  // Minimal bot init (polling=false, webhook=false → no Telegram traffic
  // initiated until we explicitly call sendMessage/sendPhoto via sendSafe).
  const TelegramBot = (await import('node-telegram-bot-api')).default;
  const bot = new TelegramBot(BOT_TOKEN, { polling: false, webHook: false });
  setBot(bot);

  console.log(`🌪️ test-tornado: dryRun=${dryRun}, limit=${limit}, telegramId=${telegramId || 'none'}`);

  const result = await sendTornadoReactivation({
    dryRun,
    limit,
    onlyTelegramIds: telegramId ? [telegramId] : null,
    source: telegramId ? 'cli-test' : (dryRun ? 'cli-dryrun' : 'cli-batch')
  });

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch(err => {
  console.error('❌ test-tornado failed:', err);
  process.exit(1);
});
