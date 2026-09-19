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
const SITE_URL = 'https://www.austsnapappraisal.com';
const LOGO_URL = 'https://www.austsnapappraisal.com/logo-icon.png';
const TAGLINE = 'The Smarter Way to Find Your Next Listing.';
const WIN_NOUN = 'listing';         // "listing" / "management"
const AGENT_NOUN = 'agent';     // "agent" / "property manager"
const INK = '#0B0B0C';
const WORDMARK = 'snap <span style="color:#FF5A1F;">appraisal</span>';         // HTML for the text logo
const AN_LEAD = 'an appraisal';           // "an appraisal" / "a rent appraisal"
const WIN_LINE = 'Keep finding listings.';         // closing line of the weekly summary
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

/* ---------------- templates ----------------
   Layout follows the agent email templates: dark brand header, kicker + headline,
   "Hi {first}", property box, CTA button, "why this matters" box, brand footer.
   Table-based + inline styles so Gmail / Outlook / Apple Mail all render it. */
const firstName = (agent) => String((agent && agent.agent_name) || '').trim().split(/\s+/)[0] || 'there';
const P = (t) => `<p style="margin:0 0 14px; font-size:15px; line-height:1.6; color:#333;">${t}</p>`;

function shell({ kicker, headline, sub, body, cta, ctaHref, why, whyTitle, preheader, unsubNote = true }) {
  return `
<!doctype html><html><body style="margin:0; padding:0; background:#F5F4F1;">
<span style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(preheader || '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F4F1; padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:16px; overflow:hidden; font-family:Poppins,Arial,Helvetica,sans-serif;">
  <tr><td style="background:${INK}; padding:18px 28px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle; padding-right:10px;"><img src="${LOGO_URL}" width="34" height="34" alt="" style="display:block; border-radius:8px;"></td>
      <td style="vertical-align:middle; font-size:19px; font-weight:800; color:#ffffff; letter-spacing:-0.01em;">${WORDMARK}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:30px 28px 6px;">
    <div style="font-size:11px; font-weight:800; letter-spacing:0.14em; color:${ACCENT}; text-transform:uppercase;">${esc(kicker)}</div>
    <div style="font-size:24px; font-weight:800; color:${INK}; line-height:1.25; margin:8px 0 6px;">${headline}</div>
    ${sub ? `<div style="font-size:14px; color:#777; line-height:1.5;">${sub}</div>` : ''}
  </td></tr>
  <tr><td style="padding:18px 28px 6px;">${body}</td></tr>
  ${cta ? `<tr><td style="padding:6px 28px 26px;"><a href="${ctaHref || PORTAL_URL}" style="display:inline-block; background:${ACCENT}; color:#ffffff; text-decoration:none; font-weight:800; font-size:15px; padding:14px 24px; border-radius:100px;">${esc(cta)} &nbsp;›</a></td></tr>` : ''}
  ${why ? `<tr><td style="padding:0 28px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#FFF6F1; border-left:4px solid ${ACCENT}; border-radius:10px; padding:14px 16px;">
    <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:${ACCENT}; text-transform:uppercase; margin-bottom:4px;">${esc(whyTitle || 'Why this matters')}</div>
    <div style="font-size:13.5px; color:#444; line-height:1.55;">${why}</div></td></tr></table></td></tr>` : ''}
  <tr><td style="background:#FAF9F6; border-top:1px solid #EEECE6; padding:18px 28px;">
    <div style="font-size:13px; font-weight:800; color:${INK};">${esc(BRAND)} Australia</div>
    <div style="font-size:12.5px; color:#777; font-style:italic; margin:2px 0 6px;">${esc(TAGLINE)}</div>
    <a href="${SITE_URL}" style="font-size:12px; color:${ACCENT}; text-decoration:none;">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a>
    ${unsubNote ? `<div style="font-size:11px; color:#AAA; margin-top:12px; line-height:1.5;">You're receiving this because it's switched on under Notifications in your ${esc(PORTAL_LABEL)}. Change what you get any time at <a href="${PORTAL_URL}" style="color:#AAA;">${esc(PORTAL_URL.replace(/^https?:\/\//, ''))}</a>.</div>` : ''}
  </td></tr>
</table></td></tr></table></body></html>`;
}
function propertyBox(title, address, rows) {
  const r = rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0; font-size:13px; color:#888; white-space:nowrap; vertical-align:top;">${esc(k)}</td><td style="padding:4px 0; font-size:14px; color:#222; font-weight:600;">${esc(v)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px;"><tr><td style="background:#F7F6F3; border-radius:12px; padding:14px 16px;">
    <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase;">${esc(title)}</div>
    <div style="font-size:17px; font-weight:800; color:${INK}; margin:4px 0 8px;">${esc(address || '(no address given)')}</div>
    ${r ? `<table role="presentation" cellpadding="0" cellspacing="0">${r}</table>` : ''}
  </td></tr></table>`;
}
function photoList(photos) {
  const links = (Array.isArray(photos) ? photos : [])
    .map((p, i) => (typeof p === 'string' ? { url: p, room: `Photo ${i + 1}` } : p))
    .filter((p) => p && p.url)
    .map((p, i) => `<li style="margin:5px 0;"><a href="${esc(p.url)}" style="color:${ACCENT}; font-weight:700; text-decoration:underline;">${esc(p.room || `Photo ${i + 1}`)}</a>${p.note ? ` <span style="color:#7A4A1E;">— ${esc(p.note)}</span>` : ''}</li>`)
    .join('');
  if (!links) return '';
  return `<div style="font-size:12px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase; margin:6px 0 4px;">Photos</div><div style="font-size:12.5px; color:#888; margin-bottom:4px;">Tap a room name to open the full-size photo.</div><ul style="padding-left:18px; margin:0 0 14px; font-size:14px;">${links}</ul>`;
}
function notesBlock(lead) {
  const photoRooms = new Set((Array.isArray(lead.photos) ? lead.photos : []).map((p) => p && p.room));
  const extra = (Array.isArray(lead.room_notes) ? lead.room_notes : []).filter((n) => n && n.note && !photoRooms.has(n.room));
  if (!extra.length) return '';
  return `<div style="font-size:12px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase; margin:6px 0 4px;">Other notes from the ${esc(CLIENT_NOUN)}</div><ul style="padding-left:18px; margin:0 0 14px; font-size:14px;">${extra.map((n) => `<li style="margin:4px 0; color:#7A4A1E;"><b style="color:#333;">${esc(n.room)}:</b> ${esc(n.note)}</li>`).join('')}</ul>`;
}
const homeLine = (lead) => [lead.bedroom_count != null ? `${lead.bedroom_count} bed` : null, lead.bathroom_count != null ? `${lead.bathroom_count} bath` : null, lead.car_spaces != null ? `${lead.car_spaces} car` : null].filter(Boolean).join(' · ') || null;
function extraRows(lead) {
  const out = [];
  if (lead.tenancy_status) out.push(['Tenancy', lead.tenancy_status]);
  if (lead.availability) out.push(['Available', lead.availability]);
  if (lead.current_management) out.push(['Managed by', lead.current_management]);
  return out;
}
const upper = (s) => String(s || '').toUpperCase();

/* 02 · Client requesting a call  /  03 · New hot lead */
function hotEmail(lead, isCall, agent) {
  const tel = String(lead.mobile || '').replace(/[^\d+]/g, '');
  const rows = [['Name', lead.full_name], ['Mobile', lead.mobile], ['Email', lead.email], ['Prefers', lead.contact_preference], ['Home', homeLine(lead)], ...extraRows(lead), ['Features', (lead.features_selected || []).join(', ') || null], [isCall ? 'Requested' : 'Completed', fmtWhen(lead.created_at)]];
  const body = isCall
    ? `${P(`Hi ${esc(firstName(agent))},`)}${P(`<b>${esc(lead.full_name || `A ${CLIENT_NOUN}`)}</b> has specifically requested a call from you regarding:`)}${propertyBox('Property', lead.address, rows)}
       ${lead.mobile ? `<a href="tel:${esc(tel)}" style="display:inline-block; background:${INK}; color:#fff; text-decoration:none; font-weight:800; font-size:15px; padding:12px 20px; border-radius:100px; margin:0 0 16px;">📞 Call ${esc(lead.mobile)}</a>` : ''}
       ${P(`They have moved beyond browsing and are actively asking to speak with ${AGENT_NOUN === 'agent' ? 'an agent' : 'a property manager'}.`)}${photoList(lead.photos)}${notesBlock(lead)}`
    : `${P(`Hi ${esc(firstName(agent))},`)}${P(`You've got a new <b>Hot Lead</b>. A ${CLIENT_NOUN} has completed their ${LEAD_NOUN} and provided their contact details.`)}${propertyBox('Property', lead.address, rows)}
       ${P(`They have already taken a meaningful step toward understanding the ${WIN_NOUN === 'listing' ? 'value' : 'rental return'} of their property. Now it is your opportunity to start the conversation.`)}${photoList(lead.photos)}${notesBlock(lead)}`;
  return {
    subject: isCall ? `CALL REQUEST: ${lead.full_name || `A ${CLIENT_NOUN}`} wants to speak with you` : `New Hot Lead: ${lead.address || `new ${LEAD_NOUN}`}`,
    html: shell({
      preheader: isCall ? `This is a high-intent ${BRAND} opportunity.` : `A ${CLIENT_NOUN} has completed their ${LEAD_NOUN} and provided contact details.`,
      kicker: isCall ? 'Priority alert' : 'New hot lead',
      headline: isCall ? `A ${CLIENT_NOUN} wants to speak with you.` : `This ${CLIENT_NOUN} completed their ${LEAD_NOUN}.`,
      sub: isCall ? `This is your highest-intent ${BRAND} notification.` : 'A meaningful property action has just become a contactable opportunity.',
      body, cta: isCall ? 'View lead & call now' : 'View hot lead',
      whyTitle: 'Why this matters',
      why: isCall ? 'Quick response matters. Their interest is active right now.' : `This is not a cold database record. The ${CLIENT_NOUN} has actively engaged with their property and completed the ${LEAD_NOUN} process. Move while the lead is warm.`,
    }),
  };
}
/* 04 · New warm lead */
function warmEmail(lead, agent) {
  const photos = Array.isArray(lead.photos) ? lead.photos : [];
  const body = `${P(`Hi ${esc(firstName(agent))},`)}${P(`A ${CLIENT_NOUN} has just uploaded their first property photo. That makes this more than a website visit: they are actively taking steps to have their property assessed.`)}
    ${propertyBox('Property', lead.address, [['Started', fmtWhen(lead.created_at)], ['Photos uploaded', String(photos.length)], ['Status', `${upper(LEAD_NOUN)[0] + LEAD_NOUN.slice(1)} in progress`]])}
    ${P(`They have not completed the process yet, so this lead remains classified as <b>Warm</b>. If they complete their ${LEAD_NOUN} or request contact, we will let you know immediately.`)}${photoList(photos)}${notesBlock(lead)}`;
  return {
    subject: `New Warm Lead: ${lead.address || `new ${LEAD_NOUN}`}`,
    html: shell({
      preheader: `Someone has uploaded their first property photo through your ${BRAND} experience.`,
      kicker: 'New warm lead', headline: `Someone has started their ${LEAD_NOUN} journey.`,
      sub: 'A photo upload is more than a page view. It is an active intent signal.',
      body, cta: 'View warm lead', whyTitle: 'Intent signal',
      why: `Small actions can be strong intent signals. ${BRAND} helps you see them earlier.`,
    }),
  };
}
/* 05 · Hot lead locked */
function lockedEmail(lead, hotCount, agent) {
  const body = `${P(`Hi ${esc(firstName(agent))},`)}${P(`A ${CLIENT_NOUN} has completed ${AN_LEAD} in your area and provided their contact information.`)}
    ${P(`That normally makes them a Hot Lead. However, you have reached the lead allowance included in your current plan: the free plan shows your ${FREE_LIMIT} most recent hot leads, and you now have ${hotCount}.`)}
    ${propertyBox('New opportunity', lead.address, [['Received', fmtWhen(lead.created_at)], ['Status', 'LOCKED']])}
    ${P(`Upgrade your plan to unlock every lead and keep receiving new Hot Leads as they arrive.`)}`;
  return {
    subject: 'A new Hot Lead has arrived, but it is currently locked',
    html: shell({
      preheader: 'You have reached the lead allowance included in your current plan.',
      kicker: 'Hot lead locked', headline: `There is a new ${WIN_NOUN} opportunity waiting for you.`,
      sub: 'The opportunity is real; the contact details are currently locked.',
      body, cta: 'Unlock my hot lead', ctaHref: PORTAL_URL,
      whyTitle: `Do not let the next ${WIN_NOUN} pass by`,
      why: `${BRAND} is designed to help you identify ${CLIENT_NOUN}s showing real property intent before they become somebody else's ${WIN_NOUN}.`,
    }),
  };
}
/* 06 · Weekly summary */
function weeklyEmail(agent, stats) {
  const cell = (label, n) => `<tr><td style="padding:9px 0; border-bottom:1px solid #EEECE6; font-size:14px; color:#444;">${esc(label)}</td><td align="right" style="padding:9px 0; border-bottom:1px solid #EEECE6; font-size:18px; font-weight:800; color:${INK};">${n}</td></tr>`;
  const total = (stats.hot || 0) + (stats.warm || 0);
  const body = `${P(`Morning ${esc(firstName(agent))},`)}${P(`Here is what happened across your ${BRAND} account over the last seven days.`)}
    <div style="font-size:12px; color:#999; margin-bottom:6px;">${esc(stats.weekStart || '')} – ${esc(stats.weekEnd || '')}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
      ${cell('Hot leads', stats.hot || 0)}${cell('Warm leads', stats.warm || 0)}${cell('Call requests', stats.calls || 0)}${cell(`${upper(LEAD_NOUN)[0] + LEAD_NOUN.slice(1)}s started`, stats.started || 0)}${cell(`${upper(LEAD_NOUN)[0] + LEAD_NOUN.slice(1)}s completed`, stats.hot || 0)}${cell('Property photos uploaded', stats.photos || 0)}
    </table>
    ${stats.topAddress ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr><td style="background:#F7F6F3; border-radius:12px; padding:14px 16px;"><div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase;">Strongest opportunity this week</div><div style="font-size:15px; font-weight:800; color:${INK}; margin-top:4px;">${esc(stats.topAddress)}</div><div style="font-size:13px; color:#666; margin-top:2px;">Status: ${esc(stats.topStatus || '')} &nbsp;|&nbsp; Activity: ${esc(stats.topActivity || '')}</div></td></tr></table>` : ''}
    <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:${ACCENT}; text-transform:uppercase;">Your total opportunity</div>
    ${P(`<b>${total}</b> ${CLIENT_NOUN}${total === 1 ? '' : 's'} showed property intent this week.${stats.pending ? ` <b>${stats.pending}</b> hot lead${stats.pending === 1 ? ' has' : 's have'} not been marked as ${WIN_NOUN === 'listing' ? 'appraised' : 'appraised'} yet.` : ''}`)}
    ${P('Keep following up. Keep building relationships. ' + WIN_LINE)}`;
  return {
    subject: `Your ${BRAND} week: ${total} new opportunit${total === 1 ? 'y' : 'ies'}`,
    html: shell({ preheader: `Here is what happened across your ${BRAND} account over the last 7 days.`, kicker: 'Your week in Snap', headline: 'A quick view of property intent from the last seven days.', body, cta: 'Review my leads' }),
  };
}
/* 01 · Welcome (sent once, at signup) */
function welcomeEmail(agent) {
  const pillar = (tag, title, text) => `<tr><td style="padding:10px 0; border-bottom:1px solid #EEECE6;"><div style="font-size:10.5px; font-weight:800; letter-spacing:0.14em; color:${ACCENT}; text-transform:uppercase;">${esc(tag)}</div><div style="font-size:15px; font-weight:800; color:${INK}; margin:2px 0;">${esc(title)}</div><div style="font-size:13.5px; color:#555; line-height:1.5;">${esc(text)}</div></td></tr>`;
  const body = `${P(`Hi ${esc(firstName(agent))},`)}${P(`Welcome to <b>${esc(BRAND)} Australia</b>.`)}
    ${P(`You now have a smarter way to discover ${CLIENT_NOUN}s who are already thinking about their property, before they become just another cold prospect in somebody else's database.`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">
      ${pillar('Smart', 'See intent, not just names.', `Identify ${CLIENT_NOUN}s actively engaging with their property, requesting ${AN_LEAD} or asking to speak with ${AGENT_NOUN === 'agent' ? 'an agent' : 'a property manager'}.`)}
      ${pillar('Bold', 'Stand out in your marketplace.', `Give ${CLIENT_NOUN}s an easy, modern ${LEAD_NOUN} experience while positioning yourself as the local ${AGENT_NOUN} ready to help.`)}
      ${pillar('Fast', 'Know when opportunity happens.', `Receive alerts when ${CLIENT_NOUN}s start, upload photos, complete ${AN_LEAD}, provide details or request a call.`)}
      ${pillar('Trustworthy', `Professional for ${CLIENT_NOUN}s. Powerful for ${AGENT_NOUN}s.`, `Create a simple, credible ${CLIENT_NOUN} experience while receiving clearer signals about potential ${WIN_NOUN === 'listing' ? 'selling' : 'leasing'} intent.`)}
    </table>
    <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase; margin-bottom:6px;">Your portal</div>
    <ul style="padding-left:18px; margin:0 0 16px; font-size:14px; color:#333; line-height:1.7;"><li>View new leads</li><li>See ${LEAD_NOUN} activity</li><li>Review ${CLIENT_NOUN} details</li><li>Track warm and hot opportunities</li><li>Manage your account and subscription</li></ul>
    ${P(`Your next ${WIN_NOUN} may already be looking for you.`)}`;
  return {
    subject: `Welcome to ${BRAND}, your next ${WIN_NOUN} starts here`,
    html: shell({ preheader: `Turn ${CLIENT_NOUN} interest into warmer, higher-quality property leads.`, kicker: `Welcome to ${BRAND}`, headline: `You're in. Let's find your next ${WIN_NOUN}.`, sub: `Smart technology. Better intent signals. Faster ${AGENT_NOUN} follow-up.`, body, cta: `Open my ${PORTAL_LABEL.toLowerCase()}`, unsubNote: false }),
  };
}
/* 07 · Mail-out status (ready for when the mail-out service goes live; nothing sends it yet) */
function mailoutEmail(agent, stage, c = {}) {
  const S = {
    production: { kicker: 'Mail-out update', headline: 'Your campaign is being produced.', subject: `Your ${BRAND} mail-out is now in production`, pre: 'Your campaign is being prepared for printing and distribution.', cta: 'View campaign', why: 'We will keep you updated as your campaign moves from production to post and delivery.', status: 'IN PRODUCTION', intro: `Your ${BRAND} mail campaign has moved into production.` },
    posted: { kicker: 'Your mail is on the move', headline: 'Your campaign has been posted.', subject: `Your ${BRAND} mail-out has been posted`, pre: 'Your campaign is officially on its way.', cta: 'Watch my campaign', why: `As ${CLIENT_NOUN}s begin interacting with your ${BRAND} campaign, you will receive Warm Lead, Hot Lead and Call Request notifications.`, status: 'POSTED', intro: `Your ${BRAND} campaign has now been posted.` },
    delivery: { kicker: 'Delivery window', headline: `Your campaign should now be reaching ${CLIENT_NOUN}s.`, subject: 'Your mail-out should be reaching homes now', pre: `Watch your portal for incoming ${CLIENT_NOUN} activity.`, cta: 'View live activity', why: 'This is when things get interesting. Watch for Warm Leads, Hot Leads and Call Requests as they respond.', status: 'DELIVERING', intro: `Your ${BRAND} mail campaign is now within its estimated delivery window.` },
  }[stage] || null;
  if (!S) return null;
  const body = `${P(`Hi ${esc(firstName(agent))},`)}${P(S.intro)}${propertyBox('Campaign', c.name || 'Your campaign', [['Area', c.area], ['Quantity', c.quantity], ['Posted', c.posted], ['Estimated delivery', c.delivery], ['Status', S.status]])}`;
  return { subject: S.subject, html: shell({ preheader: S.pre, kicker: S.kicker, headline: S.headline, body, cta: S.cta, whyTitle: 'What happens next', why: S.why }) };
}
function testEmail(agent) {
  const body = `${P(`Hi ${esc(firstName(agent))},`)}${P(`This is a test from your Notifications page. If you can read this, lead alerts will reach <b>${esc(agent.email)}</b>.`)}`;
  return { subject: `${BRAND} test email`, html: shell({ preheader: 'Your email alerts are working.', kicker: 'Test', headline: 'Email alerts are working.', body, cta: `Back to my ${PORTAL_LABEL.toLowerCase()}` }) };
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
      const { subject, html } = hotEmail(lead, isCall, agent);
      await notify({ agent, kind, leadId: lead.id, subject, html });

      // Free-plan limit: only the FREE_LIMIT most recent hot leads are unlocked
      const hasAccess = !!agent.trial_active || agent.subscription_status === 'active';
      if (!hasAccess) {
        const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leads?agent_id=eq.${agent.id}&lead_type=eq.Hot%20Lead&banked=not.is.true&select=id`, { headers: sbHeaders({ Prefer: 'count=exact' }) });
        const hotCount = res.ok ? (await res.json()).length : 0;
        if (hotCount > FREE_LIMIT) {
          const t = lockedEmail(lead, hotCount, agent);
          await notify({ agent, kind: 'locked', leadId: lead.id, subject: t.subject, html: t.html });
        }
      }
      return;
    }

    // Warm lead: alert once, the first time a photo lands (address alone is too early)
    if (photos.length >= 1) {
      const { subject, html } = warmEmail(lead, agent);
      await notify({ agent, kind: 'warm', leadId: lead.id, subject, html });
    }
  } catch (err) {
    console.error('notifyForLead failed (non-fatal):', err);
  }
}

// Welcome email at signup: sent once, logged, never blocks the signup response
async function sendWelcome(agent) {
  try {
    if (!agent || !agent.email) return;
    const { subject, html } = welcomeEmail(agent);
    const r = await sendEmail({ to: agent.email, subject, html });
    await log({ agent_id: agent.id, kind: 'welcome', to_email: agent.email, subject, status: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'), error: r.ok ? null : r.error, provider_id: r.id || null });
  } catch (e) { console.error('welcome email failed (non-fatal)', e); }
}

module.exports = { notify, notifyForLead, sendEmail, getAgent, wantsEmail, weeklyEmail, welcomeEmail, sendWelcome, mailoutEmail, hotEmail, warmEmail, lockedEmail, testEmail, NOTIFY_DEFAULTS, sbHeaders, log };
