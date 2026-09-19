// netlify/functions/lib/notify.js
//
// Email-only agent notifications (no SMS). Shared by:
//   • submit-lead.js (app)      — call / hot / warm / locked alerts as leads arrive
//   • weekly-summary.js (portal) — Monday morning summary
//   • notify-test.js (portal)    — "Send me a test email" button
//
// Every attempt (sent, failed or skipped) is written to the notification_log
// table so the portal's Notifications page can show exactly what went out.
//
// Sending: Resend (https://resend.com) via RESEND_API_KEY, or a Make.com /
// Zapier webhook via LEAD_EMAIL_WEBHOOK that receives {to, subject, html}.
// If neither is set nothing is sent; the attempt is logged as "skipped" so
// you can see it in the portal instead of wondering why nothing arrived.
//
// Env (values live in Netlify, never in this repo):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (already set)
//   RESEND_API_KEY                            (re_...)
//   LEAD_EMAIL_FROM                           e.g. "Snap Appraisal <alerts@austsnapappraisal.com>"
//                                             (sender domain must be verified in Resend;
//                                              "onboarding@resend.dev" works for testing)
//   LEAD_EMAIL_WEBHOOK                        optional alternative to Resend

const BRAND = 'Snap Appraisal';
const PORTAL_URL = 'https://portal.austsnapappraisal.com';
const PORTAL_LABEL = 'Agent Portal';
const ACCENT = '#FF5A1F';
const LEAD_NOUN = 'appraisal';       // "appraisal" / "rent appraisal"
const CLIENT_NOUN = 'homeowner';   // "homeowner" / "owner"
const FREE_LIMIT = 3;

// What each alert type means. Email defaults apply when the agent has never
// saved preferences; weekly is opt-in.
const NOTIFY_DEFAULTS = {
  call: { email: true },
  hot: { email: true },
  warm: { email: true },
  locked: { email: true },
  weekly: { email: false },
  mailout: { email: true },
};

function sbHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtWhen = (iso) => new Date(iso || Date.now()).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' });

function wantsEmail(agent, kind) {
  const prefs = (agent && agent.notify_prefs && typeof agent.notify_prefs === 'object') ? agent.notify_prefs : {};
  const p = prefs[kind];
  if (p && typeof p.email === 'boolean') return p.email;
  return !!(NOTIFY_DEFAULTS[kind] && NOTIFY_DEFAULTS[kind].email);
}

async function getAgent(agentId) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}&select=id,agent_name,agency_name,email,notify_prefs,is_active,trial_active,subscription_status`, { headers: sbHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function alreadySent(leadId, kind) {
  if (!leadId) return false;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/notification_log?lead_id=eq.${leadId}&kind=eq.${kind}&status=in.(sent,skipped)&select=id&limit=1`, { headers: sbHeaders() });
  if (!res.ok) return false;
  return (await res.json()).length > 0;
}

async function log(entry) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/notification_log`, {
      method: 'POST', headers: sbHeaders(), body: JSON.stringify({ channel: 'email', ...entry }),
    });
  } catch (e) { console.error('notification_log write failed', e); }
}

// Low-level send. Returns {ok, id?, error?}. Never throws.
async function sendEmail({ to, subject, html }) {
  try {
    if (process.env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.LEAD_EMAIL_FROM || `${BRAND} <onboarding@resend.dev>`, to: [to], subject, html }),
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
      let id = null; try { id = JSON.parse(body).id || null; } catch (_) {}
      return { ok: true, id };
    }
    if (process.env.LEAD_EMAIL_WEBHOOK) {
      const res = await fetch(process.env.LEAD_EMAIL_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, html }),
      });
      if (!res.ok) return { ok: false, error: `Webhook ${res.status}` };
      return { ok: true, id: 'webhook' };
    }
    return { ok: false, skipped: true, error: 'No email provider configured (set RESEND_API_KEY or LEAD_EMAIL_WEBHOOK)' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// Sends one alert to one agent, honouring their preferences, and logs it.
async function notify({ agent, kind, leadId = null, subject, html }) {
  if (!agent || !agent.email) return { ok: false, error: 'no agent email' };
  if (agent.is_active === false) return { ok: false, error: 'agent inactive' };
  if (!wantsEmail(agent, kind)) return { ok: false, error: 'opted out' };
  if (leadId && await alreadySent(leadId, kind)) return { ok: false, error: 'already sent' };
  const r = await sendEmail({ to: agent.email, subject, html });
  await log({
    agent_id: agent.id, lead_id: leadId, kind, to_email: agent.email, subject,
    status: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'),
    error: r.ok ? null : r.error, provider_id: r.id || null,
  });
  if (!r.ok) console.error(`notify ${kind} not sent:`, r.error);
  return r;
}

/* ---------------- templates ---------------- */
function shell(kicker, title, body) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif; max-width:560px; margin:0 auto; color:#0D0D0D;">
      <div style="font-size:11px; letter-spacing:0.12em; color:${ACCENT}; font-weight:700;">${esc(BRAND).toUpperCase()} · ${esc(kicker)}</div>
      <h2 style="margin:6px 0 14px; font-size:22px;">${title}</h2>
      ${body}
      <div style="margin-top:22px; font-size:11px; color:#999;">You're getting this because it's ticked on your Notifications page in the ${esc(PORTAL_LABEL)} · <a href="${PORTAL_URL}" style="color:#999;">${esc(PORTAL_URL.replace(/^https?:\/\//, ''))}</a></div>
    </div>`;
}
const row = (label, value) => `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px; white-space:nowrap; vertical-align:top;">${esc(label)}</td><td style="padding:6px 0; font-size:14px;">${esc(value || 'Not given')}</td></tr>`;
const button = (label) => `<a href="${PORTAL_URL}" style="display:inline-block; background:${ACCENT}; color:#fff; text-decoration:none; font-weight:700; padding:12px 18px; border-radius:10px; margin:12px 0 4px;">${esc(label)}</a>`;
function photoList(photos) {
  const links = (Array.isArray(photos) ? photos : [])
    .map((p, i) => (typeof p === 'string' ? { url: p, room: `Photo ${i + 1}` } : p))
    .filter((p) => p && p.url)
    .map((p, i) => `<li style="margin:6px 0;"><a href="${esc(p.url)}" style="color:${ACCENT}; font-weight:700; text-decoration:underline;">${esc(p.room || `Photo ${i + 1}`)}</a>${p.note ? ` <span style="color:#7A4A1E;">— ${esc(p.note)}</span>` : ''}</li>`)
    .join('');
  return `<div style="font-size:13px; color:#888; margin:14px 0 6px;">Photos, tap a room name to open the full-size photo:</div><ul style="padding-left:18px; margin:0;">${links || '<li style="color:#999;">No photos yet</li>'}</ul>`;
}
function notesBlock(lead) {
  const photoRooms = new Set((Array.isArray(lead.photos) ? lead.photos : []).map((p) => p && p.room));
  const extra = (Array.isArray(lead.room_notes) ? lead.room_notes : []).filter((n) => n && n.note && !photoRooms.has(n.room));
  if (!extra.length) return '';
  return `<div style="font-size:13px; color:#888; margin:12px 0 4px;">Other notes from the client:</div><ul style="padding-left:18px; margin:0;">${extra.map((n) => `<li style="margin:4px 0; color:#7A4A1E;"><b style="color:#333;">${esc(n.room)}:</b> ${esc(n.note)}</li>`).join('')}</ul>`;
}
function extraRows(lead) {
  // Product-specific fields (rent app only); harmless when absent
  let out = '';
  if (lead.tenancy_status) out += row('Tenancy', lead.tenancy_status);
  if (lead.availability) out += row('Available', lead.availability);
  if (lead.current_management) out += row('Managed by', lead.current_management);
  if (lead.bedroom_count) out += row('Bedrooms', lead.bedroom_count);
  return out;
}

function hotEmail(lead, isCall) {
  const tel = String(lead.mobile || '').replace(/[^\d+]/g, '');
  const banner = isCall && lead.mobile
    ? `<div style="background:${ACCENT}; color:#fff; border-radius:10px; padding:12px 14px; font-weight:700; margin:0 0 14px;">📞 ${CLIENT_NOUN.toUpperCase()} REQUESTING A CALL · <a href="tel:${esc(tel)}" style="color:#fff;">${esc(lead.mobile)}</a></div>`
    : '';
  const body = `${banner}
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:6px;">
      ${row('Name', lead.full_name)}${row('Mobile', lead.mobile)}${row('Email', lead.email)}${row('Prefers', lead.contact_preference)}
      ${extraRows(lead)}
      ${row('Features', (lead.features_selected || []).join(', ') || 'None selected')}
      ${row('Completed', fmtWhen(lead.created_at))}
    </table>
    ${photoList(lead.photos)}${notesBlock(lead)}
    <div style="margin-top:16px;">${button(isCall ? 'Open the lead and call them' : 'Open in your portal')}</div>`;
  return {
    subject: isCall ? `📞 Call requested: ${lead.address || 'new ' + LEAD_NOUN}` : `🔥 Hot lead: ${lead.address || 'new ' + LEAD_NOUN}`,
    html: shell(isCall ? 'CALL REQUESTED' : 'HOT LEAD', esc(lead.address || '(no address given)'), body),
  };
}
function warmEmail(lead) {
  const body = `
    <p style="font-size:14px; line-height:1.6; margin:0 0 6px;">A ${CLIENT_NOUN} has started photographing their property on your app. No contact details yet — if they finish, you'll get a hot lead alert. Warm leads with photos are still worth a doorknock or a letter.</p>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${row('Started', fmtWhen(lead.created_at))}${row('Rooms so far', String((lead.photos || []).length))}</table>
    ${photoList(lead.photos)}${notesBlock(lead)}
    <div style="margin-top:16px;">${button('See warm leads')}</div>`;
  return { subject: `Warm lead: ${lead.address || 'new ' + LEAD_NOUN} (in progress)`, html: shell('WARM LEAD', esc(lead.address || '(no address yet)'), body) };
}
function lockedEmail(lead, hotCount) {
  const body = `
    <p style="font-size:14px; line-height:1.6; margin:0 0 10px;">A new hot lead just came in for <b>${esc(lead.address || 'a property')}</b>. You now have <b>${hotCount}</b> hot leads but the free plan shows the ${FREE_LIMIT} most recent, so an older lead's contact details are now hidden.</p>
    <p style="font-size:14px; line-height:1.6; margin:0;">Upgrade in your portal to unlock every lead, past and future.</p>
    <div style="margin-top:16px;">${button('Unlock all leads')}</div>`;
  return { subject: `You're over the free limit: ${hotCount} hot leads waiting`, html: shell('LEAD LOCKED', 'A hot lead is now locked', body) };
}
function weeklyEmail(agent, stats) {
  const stat = (n, label) => `<td style="padding:12px 14px; border:1px solid #eee; border-radius:10px; text-align:center;"><div style="font-size:26px; font-weight:800; color:${ACCENT};">${n}</div><div style="font-size:12px; color:#888;">${esc(label)}</div></td>`;
  const body = `
    <p style="font-size:14px; line-height:1.6; margin:0 0 12px;">Hi ${esc((agent.agent_name || '').split(' ')[0] || 'there')}, here's your last 7 days on ${esc(BRAND)}.</p>
    <table cellpadding="0" cellspacing="8" style="border-collapse:separate; margin:0 0 8px;"><tr>${stat(stats.hot, 'hot leads')}${stat(stats.calls, 'call requests')}${stat(stats.warm, 'warm leads')}${stat(stats.total, 'all-time leads')}</tr></table>
    ${stats.pending ? `<p style="font-size:14px; line-height:1.6; margin:8px 0 0;"><b>${stats.pending}</b> hot lead${stats.pending === 1 ? ' has' : 's have'} not been marked as appraised yet.</p>` : ''}
    <div style="margin-top:16px;">${button('Open your portal')}</div>`;
  return { subject: `Your week: ${stats.hot} hot, ${stats.warm} warm`, html: shell('WEEKLY SUMMARY', 'Weekly summary', body) };
}
function testEmail(agent) {
  const body = `<p style="font-size:14px; line-height:1.6;">This is a test from your Notifications page. If you can read this, lead alerts will reach <b>${esc(agent.email)}</b>.</p><div>${button('Back to your portal')}</div>`;
  return { subject: `${BRAND} test email`, html: shell('TEST', 'Email alerts are working', body) };
}

/* ---------------- high-level: called after a lead is saved ---------------- */
// lead = the saved Supabase row. isNew = row was inserted (not updated).
async function notifyForLead(lead, { isNew } = {}) {
  if (!lead || !lead.agent_id) return;
  try {
    const agent = await getAgent(lead.agent_id);
    if (!agent) return;
    const photos = Array.isArray(lead.photos) ? lead.photos : [];

    if (lead.lead_type === 'Hot Lead') {
      const isCall = String(lead.contact_preference || '').toLowerCase() === 'call' && !!lead.mobile;
      const kind = isCall ? 'call' : 'hot';
      const { subject, html } = hotEmail(lead, isCall);
      await notify({ agent, kind, leadId: lead.id, subject, html });

      // Free-plan limit: only the FREE_LIMIT most recent hot leads are unlocked
      const hasAccess = !!agent.trial_active || agent.subscription_status === 'active';
      if (!hasAccess) {
        const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leads?agent_id=eq.${agent.id}&lead_type=eq.Hot%20Lead&banked=not.is.true&select=id`, { headers: sbHeaders({ Prefer: 'count=exact' }) });
        const hotCount = res.ok ? (await res.json()).length : 0;
        if (hotCount > FREE_LIMIT) {
          const t = lockedEmail(lead, hotCount);
          await notify({ agent, kind: 'locked', leadId: lead.id, subject: t.subject, html: t.html });
        }
      }
      return;
    }

    // Warm lead: alert once, the first time a photo lands (address alone is too early)
    if (photos.length >= 1) {
      const { subject, html } = warmEmail(lead);
      await notify({ agent, kind: 'warm', leadId: lead.id, subject, html });
    }
  } catch (err) {
    console.error('notifyForLead failed (non-fatal):', err);
  }
}

module.exports = { notify, notifyForLead, sendEmail, getAgent, wantsEmail, weeklyEmail, testEmail, NOTIFY_DEFAULTS, sbHeaders, log };
