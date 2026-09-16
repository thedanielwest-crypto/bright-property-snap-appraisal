// netlify/functions/lib/ratelimit.js
//
// Simple fixed-window rate limiter backed by the `rate_limits` table in
// Supabase (key, window_start, count). Good enough to stop credential
// stuffing, sign-up floods and lead spam without adding another service.
//
//   const { rateLimit, clientIp } = require('./lib/ratelimit');
//   const hit = await rateLimit(`login:${clientIp(event)}`, 10, 15 * 60); // 10 per 15 min
//   if (hit.blocked) return hit.response;
//
// Fails OPEN (allows the request) if Supabase is unreachable, so a database
// blip never locks everyone out.

function sbHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function clientIp(event) {
  const h = event.headers || {};
  return (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}

async function rateLimit(key, max, windowSeconds) {
  const ok = { blocked: false };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return ok;
  const safeKey = String(key).slice(0, 180);
  const now = Date.now();
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limits?key=eq.${encodeURIComponent(safeKey)}&select=window_start,count`, { headers: sbHeaders() });
    const rows = res.ok ? await res.json() : [];
    const row = rows[0];
    const fresh = !row || (now - new Date(row.window_start).getTime()) > windowSeconds * 1000;
    const count = fresh ? 1 : (row.count || 0) + 1;
    if (count > max) {
      const retry = Math.max(1, Math.ceil((new Date(row.window_start).getTime() + windowSeconds * 1000 - now) / 1000));
      return {
        blocked: true,
        response: { statusCode: 429, headers: { 'Retry-After': String(retry) }, body: 'Too many attempts. Please wait a few minutes and try again.' },
      };
    }
    const body = fresh
      ? { key: safeKey, window_start: new Date(now).toISOString(), count: 1 }
      : { key: safeKey, window_start: row.window_start, count };
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limits?on_conflict=key`, {
      method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(body),
    });
    return ok;
  } catch (err) {
    console.error('rateLimit error (failing open):', err.message);
    return ok;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validEmail(v) { return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim()); }

module.exports = { rateLimit, clientIp, validEmail };
