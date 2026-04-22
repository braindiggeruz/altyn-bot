# Алтын Therapy Bot — Telegram CRM v3.0.0

Telegram бот с квизом, автоматическим прогревом и полноценной CRM-системой для проекта **Алтын Therapy**.

## What's New in v3.0.0

- **PostgreSQL Migration** — Data persists across redeploys (was SQLite)
- **Webhook Mode** — No more 409 Conflict errors or bot "freezing"
- **Async Database Layer** — All DB operations are async/await with `pg` pool

## 🤖 Бот

**@altyntherapybot** — https://t.me/altyntherapybot

## 🚀 Стек

- Node.js 22 + Express
- node-telegram-bot-api (webhook in production)
- PostgreSQL (Railway plugin)
- JWT авторизация
- Railway (хостинг)

## 📊 Функционал

### Для пользователей
- **Квиз** — 5 вопросов, определяет бессознательный сценарий (СПАСАТЕЛЬ, ЖЕРТВА, ПЕРФЕКЦИОНИСТ, НЕВИДИМКА)
- **Прогрев** — 8 дней автоматических персонализированных сообщений (ежедневно в 10:00 Алматы)
- **Запись** — сбор имени, телефона, удобного времени
- **Реферальная программа** — уникальные ссылки для каждого пользователя

### Для администратора
- **CRM** — управление пользователями, теги, заметки, задачи
- **Аналитика** — воронка, конверсия, активность, тепловая карта
- **Рассылки** — сегментированные, A/B тесты, отложенные
- **UTM-метки** — отслеживание источников трафика
- **CSV экспорт** — выгрузка базы пользователей

## ⚙️ Переменные окружения

| Переменная | Описание | Обязательно |
|:-----------|:---------|:-----------:|
| `BOT_TOKEN` | Telegram Bot Token | ✅ |
| `JWT_SECRET` | Секрет для JWT токенов | ✅ |
| `ADMIN_USERNAME` | Логин администратора | ✅ |
| `ADMIN_PASSWORD` | Пароль администратора | ✅ |
| `NOTIFY_GROUP_ID` | **ID Telegram группы для уведомлений о заявках** | ✅ |
| `OWNER_TELEGRAM_ID` | Telegram ID владельца (дополнительно) | ⬜ |
| `NODE_ENV` | `production` | ✅ |
| `PORT` | Порт сервера (по умолчанию 3000) | ⬜ |

> **Важно:** Добавьте `NOTIFY_GROUP_ID` в Railway Variables. Без него уведомления о новых заявках не будут приходить!

## 🔔 Как получить NOTIFY_GROUP_ID

1. Создайте группу в Telegram (например "Алтын Заявки")
2. Добавьте бота @altyntherapybot в группу как **администратора**
3. Напишите любое сообщение в группу
4. Откройте: `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
5. Найдите `"chat":{"id":` — это и есть NOTIFY_GROUP_ID (отрицательное число, например `-1001234567890`)

## 🌐 API Эндпоинты

- `GET /health` — статус сервиса и версия
- `POST /api/auth/login` — авторизация в CRM
- `GET /api/dashboard` — статистика
- `GET /api/users` — список пользователей
- `POST /api/broadcasts` — создание рассылки
- `GET /api/users/export/csv` — экспорт базы

## 🔒 Безопасность

- Rate limiting на login: максимум 10 попыток за 15 минут
- JWT токены с истечением 30 дней
- Валидация входных данных

## 📋 Cron Jobs

| Задача | Время |
|:-------|:------|
| Прогрев сообщения | 10:00 Алматы (05:00 UTC) |
| Напоминания | Каждые 2 часа |
| Запланированные рассылки | Каждые 5 минут |
| Статистика в логи | Каждые 6 часов |

## 🔗 Связанные репозитории

- **altyn** — Лендинг (GitHub Pages)
- **altyn-therapy** — Лендинг (Cloudflare Pages)

## 📞 Контакты

- Telegram: [@altyntherapybot](https://t.me/altyntherapybot)
- WhatsApp: [+7 707 719 85 61](https://wa.me/77077198561)
