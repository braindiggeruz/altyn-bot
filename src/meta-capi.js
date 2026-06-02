// ============================================================
// src/meta-capi.js — server-side Meta Conversions API dispatcher (v5.2)
// ------------------------------------------------------------
// Off by default. Activates only when META_CAPI_PIXEL_ID + META_CAPI_ACCESS_TOKEN
// env vars are set. Sends a tiny subset of events that matter for ad optimisation.
//
// Privacy:
//   • We hash telegram_id with sha256 and pass it as external_id only.
//   • No name, no phone, no message content is sent.
//   • Failure to deliver to Meta NEVER blocks the main funnel — errors are swallowed.
// ============================================================
import crypto from 'crypto';
import { CAPI_EVENT_MAP } from './altyn-v52-content.js';

const PIXEL_ID = process.env.META_CAPI_PIXEL_ID || '';
const ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN || '';
const TEST_EVENT_CODE = process.env.META_CAPI_TEST_EVENT_CODE || '';
const ENABLED = !!(PIXEL_ID && ACCESS_TOKEN);

function sha256(s) {
  if (!s) return null;
  return crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
}

/**
 * Fire a server-side Meta CAPI event.
 * @param {string} eventName — one of the keys in CAPI_EVENT_MAP
 * @param {object} user     — { telegram_id, source, creative, scenario }
 * @param {object} extra    — { value, currency }  (overrides defaults from CAPI_EVENT_MAP)
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function fireCapi(eventName, user = {}, extra = {}) {
  if (!ENABLED) return { sent: false, reason: 'disabled' };
  const mapping = CAPI_EVENT_MAP[eventName];
  if (!mapping) return { sent: false, reason: 'unknown-event' };

  try {
    const event = {
      event_name: mapping.capi,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'business_messaging',
      event_source_url: process.env.WEBHOOK_URL || 'https://bot.altyn-therapy.uz',
      event_id: `${eventName}_${user.telegram_id}_${Date.now()}`,
      user_data: {
        external_id: sha256(user.telegram_id),
      },
      custom_data: {
        content_name: user.scenario || null,
        content_category: user.source || null,
        utm_source: user.utm_source || null,
        utm_campaign: user.utm_campaign || null,
        creative_id: user.creative || null,
      },
    };

    const value = extra.value ?? mapping.value;
    const currency = extra.currency ?? mapping.currency;
    if (value != null) {
      event.custom_data.value = value;
      event.custom_data.currency = currency || 'USD';
    }

    const body = { data: [event] };
    if (TEST_EVENT_CODE) body.test_event_code = TEST_EVENT_CODE;

    const url = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn(`[meta-capi] ${eventName} → HTTP ${r.status}: ${txt.slice(0, 200)}`);
      return { sent: false, reason: `http_${r.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.warn(`[meta-capi] ${eventName} → error: ${e.message}`);
    return { sent: false, reason: 'exception' };
  }
}

export const CAPI_ENABLED = ENABLED;
