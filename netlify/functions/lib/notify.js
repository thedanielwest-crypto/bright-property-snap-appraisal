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
async function sendEmail({ to, subject, html, attachments }) {
  try {
    if (process.env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.LEAD_EMAIL_FROM || `${BRAND} <onboarding@resend.dev>`, to: [to], subject, html, ...(attachments && attachments.length ? { attachments } : {}) }),
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
      let id = null; try { id = JSON.parse(body).id || null; } catch (_) {}
      return { ok: true, id };
    }
    if (process.env.LEAD_EMAIL_WEBHOOK) {
      const res = await fetch(process.env.LEAD_EMAIL_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, html, attachments: attachments || [] }),
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
  // Mobile / Email values become tap-to-call / tap-to-email links
  const val = (k, v) => {
    if (k === 'Mobile' && /\d{6,}/.test(String(v).replace(/\D/g, ''))) return `<a href="tel:${esc(String(v).replace(/[^\d+]/g, ''))}" style="color:#222; text-decoration:underline;">${esc(v)}</a>`;
    if (k === 'Email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) return `<a href="mailto:${esc(v)}" style="color:#222; text-decoration:underline;">${esc(v)}</a>`;
    return esc(v);
  };
  const r = rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0; font-size:13px; color:#888; white-space:nowrap; vertical-align:top;">${esc(k)}</td><td style="padding:4px 0; font-size:14px; color:#222; font-weight:600;">${val(k, v)}</td></tr>`).join('');
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
const CHANNEL_LABEL = { postcard: 'Postcard', letter: 'Letter', flyer: 'Flyer', property_sign: 'Property sign', billboard: 'Billboard', window_display: 'Window display', social: 'Social media', email_signature: 'Email signature', other: 'Other' };
// "Source" row: campaign QR (Full Access) or what the client tapped
function sourceRow(lead, agent) {
  const hasAccess = !!(agent && (agent.trial_active || agent.subscription_status === 'active'));
  if (!hasAccess) return null;
  if (!lead.source_channel) return ['Source', 'Direct (main app link)'];
  const label = CHANNEL_LABEL[lead.source_channel] || lead.source_channel;
  return ['Source', lead.source_self_reported ? `${label} (client told us)` : `${label}${lead.source_name ? ' — ' + lead.source_name : ''}`];
}

/* ================= EDITABLE TEMPLATES =================
   Every email below is built from a template: the wording lives in
   TEMPLATE_DEFAULTS and founders can override any field from the portal
   (Founders › Email templates → stored in the email_templates table).
   Placeholders like {first} or {address} are filled at send time. */
const CAP = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const AN_AGENT = AGENT_NOUN === 'agent' ? 'an agent' : 'a property manager';
const TEMPLATE_FIELDS = ['subject', 'preheader', 'kicker', 'headline', 'sub', 'intro', 'outro', 'cta', 'whyTitle', 'why'];
const TEMPLATE_DEFAULTS = {
  call: { label: 'Client requesting a call', group: 'Lead alerts', vars: ['first', 'clientName', 'address', 'mobile', 'brand'],
    subject: 'CALL REQUEST: {clientName} wants to speak with you', preheader: 'This is a high-intent {brand} opportunity.', kicker: 'Priority alert', headline: `A ${CLIENT_NOUN} wants to speak with you.`, sub: 'This is your highest-intent {brand} notification.',
    intro: '{clientName} has specifically requested a call from you regarding:', outro: `They have moved beyond browsing and are actively asking to speak with ${AN_AGENT}.`, cta: 'View lead & call now', whyTitle: 'Why this matters', why: 'Quick response matters. Their interest is active right now.' },
  hot: { label: 'New hot lead', group: 'Lead alerts', vars: ['first', 'clientName', 'address', 'brand'],
    subject: 'New Hot Lead: {address}', preheader: `A ${CLIENT_NOUN} has completed their ${LEAD_NOUN} and provided contact details.`, kicker: 'New hot lead', headline: `This ${CLIENT_NOUN} completed their ${LEAD_NOUN}.`, sub: 'A meaningful property action has just become a contactable opportunity.',
    intro: `You've got a new Hot Lead. A ${CLIENT_NOUN} has completed their ${LEAD_NOUN} and provided their contact details.`, outro: `They have already taken a meaningful step toward understanding the ${WIN_NOUN === 'listing' ? 'value' : 'rental return'} of their property. Now it is your opportunity to start the conversation.`, cta: 'View hot lead', whyTitle: 'Why this matters', why: `This is not a cold database record. The ${CLIENT_NOUN} has actively engaged with their property and completed the ${LEAD_NOUN} process. Move while the lead is warm.` },
  warm: { label: 'New warm lead', group: 'Lead alerts', vars: ['first', 'address', 'photos', 'brand'],
    subject: 'New Warm Lead: {address}', preheader: 'Someone has uploaded their first property photo through your {brand} experience.', kicker: 'New warm lead', headline: `Someone has started their ${LEAD_NOUN} journey.`, sub: 'A photo upload is more than a page view. It is an active intent signal.',
    intro: `A ${CLIENT_NOUN} has just uploaded their first property photo. That makes this more than a website visit: they are actively taking steps to have their property assessed.`, outro: `They have not completed the process yet, so this lead remains classified as Warm. If they complete their ${LEAD_NOUN} or request contact, we will let you know immediately.`, cta: 'View warm lead', whyTitle: 'Intent signal', why: 'Small actions can be strong intent signals. {brand} helps you see them earlier.' },
  locked: { label: 'Hot lead locked (free plan)', group: 'Lead alerts', vars: ['first', 'address', 'hotCount', 'freeLimit', 'brand'],
    subject: 'A new Hot Lead has arrived, but it is currently locked', preheader: 'You have reached the lead allowance included in your current plan.', kicker: 'Hot lead locked', headline: `There is a new ${WIN_NOUN} opportunity waiting for you.`, sub: 'The opportunity is real; the contact details are currently locked.',
    intro: `A ${CLIENT_NOUN} has completed ${AN_LEAD} in your area and provided their contact information. That normally makes them a Hot Lead. However, you have reached the lead allowance included in your current plan: the free plan shows your {freeLimit} most recent hot leads, and you now have {hotCount}.`, outro: 'Upgrade your plan to unlock every lead and keep receiving new Hot Leads as they arrive.', cta: 'Unlock my hot lead', whyTitle: `Do not let the next ${WIN_NOUN} pass by`, why: `{brand} is designed to help you identify ${CLIENT_NOUN}s showing real property intent before they become somebody else's ${WIN_NOUN}.` },
  weekly: { label: 'Weekly summary', group: 'Summaries', vars: ['first', 'total', 'pending', 'weekStart', 'weekEnd', 'brand'],
    subject: 'Your {brand} week: {total} new opportunities', preheader: 'Here is what happened across your {brand} account over the last 7 days.', kicker: 'Your week in Snap', headline: 'A quick view of property intent from the last seven days.', sub: '',
    intro: 'Here is what happened across your {brand} account over the last seven days.', outro: 'Keep following up. Keep building relationships. ' + WIN_LINE, cta: 'Review my leads', whyTitle: '', why: '' },
  welcome: { label: 'Welcome (at sign-up)', group: 'Account', vars: ['first', 'brand', 'portal'],
    subject: `Welcome to {brand}, your next ${WIN_NOUN} starts here`, preheader: `Turn ${CLIENT_NOUN} interest into warmer, higher-quality property leads.`, kicker: 'Welcome to {brand}', headline: `You're in. Let's find your next ${WIN_NOUN}.`, sub: `Smart technology. Better intent signals. Faster ${AGENT_NOUN} follow-up.`,
    intro: `Welcome to {brand} Australia. You now have a smarter way to discover ${CLIENT_NOUN}s who are already thinking about their property, before they become just another cold prospect in somebody else's database.`, outro: `Your next ${WIN_NOUN} may already be looking for you.`, cta: `Open my ${PORTAL_LABEL.toLowerCase()}`, whyTitle: '', why: '' },
  trial5: { label: 'Free month ending in 5 days (SAVETIME giveaway)', group: 'Launch giveaway', vars: ['first', 'daysLeft', 'trialEnds', 'brand', 'portal'],
    subject: '5 days left of your free Full Access, {first}', preheader: 'Your SAVETIME month ends on {trialEnds}. Keep every lead flowing.', kicker: 'Launch giveaway', headline: 'Your free month of Full Access ends in {daysLeft} days.', sub: 'Everything you have unlocked stays yours when you subscribe before {trialEnds}.',
    intro: `Your SAVETIME launch giveaway has given you a full month of {brand} Full Access: every hot and warm lead unlocked, campaign QR codes, analytics and the branded reports. It ends on {trialEnds}.`, outro: `Subscribe now and nothing changes on the day: your leads, campaigns and QR codes carry straight on. From $49 a month, cancel any time. Referred by a colleague? Your $10 off is applied automatically at checkout.`, cta: 'Keep Full Access', whyTitle: 'What happens if you don\'t', why: 'On {trialEnds} your account drops back to the free plan: your 3 most recent hot leads stay unlocked, the rest are blurred, and campaign QR codes and analytics switch off until you subscribe.' },
  trial1: { label: 'Free month ending in 24 hours (SAVETIME giveaway)', group: 'Launch giveaway', vars: ['first', 'trialEnds', 'brand', 'portal'],
    subject: 'Last day: your free Full Access ends tomorrow', preheader: 'Your SAVETIME month ends {trialEnds}. One tap keeps everything.', kicker: 'Ends tomorrow', headline: 'Your free month of Full Access ends in 24 hours.', sub: 'Subscribe today and your leads, campaigns and QR codes carry straight on.',
    intro: 'This is the last reminder: your SAVETIME launch giveaway month of {brand} Full Access finishes on {trialEnds}.', outro: 'It takes about a minute: Subscription › Monthly, 6 months or 12 months. Referred by a colleague? Your $10 off is applied automatically at checkout.', cta: 'Subscribe now', whyTitle: 'After tomorrow', why: 'Your account drops back to the free plan: 3 most recent hot leads unlocked, the rest blurred, campaign QR codes and analytics paused. Everything comes straight back the moment you subscribe.' },
  trialend: { label: 'Free month has ended', group: 'Launch giveaway', vars: ['first', 'brand', 'portal'],
    subject: 'Your free Full Access has ended — here\'s how to get it back', preheader: 'Your SAVETIME month has finished. Your account is on the free plan.', kicker: 'Free month over', headline: 'Your launch giveaway month has ended.', sub: 'You\'re on the free plan now. Subscribe any time to unlock everything again.',
    intro: 'Thanks for trying {brand} Full Access. Your SAVETIME month has finished, so your account is now on the free plan: your 3 most recent hot leads stay unlocked and your QR code keeps working.', outro: 'Subscribe from $49 a month and every lead, campaign and report is unlocked again instantly.', cta: 'Unlock Full Access', whyTitle: '', why: '' },
  referral_reward: { label: 'Referral reward ($10 off)', group: 'Account', vars: ['first', 'referredName', 'brand'],
    subject: 'You\'ve earned $10 off — {referredName} just subscribed', preheader: 'Your referral subscribed to {brand}. $10 comes off your next payment.', kicker: 'Share & Earn', headline: '{referredName} subscribed. That\'s $10 off for you.', sub: 'Thanks for spreading the word.',
    intro: '{referredName} signed up with your referral link and has just subscribed to {brand} Full Access. As a thank-you, $10 comes off your next monthly payment (if you haven\'t subscribed yet, it\'s applied at your checkout).', outro: 'Keep sharing your link under Share & Earn — every colleague who subscribes is another $10 off, and they get $10 off their first payment too.', cta: 'Open Share & Earn', whyTitle: '', why: '' },
  mailout_production: { label: 'Mail-out: in production', group: 'Mail-out status', vars: ['first', 'campaign', 'brand'],
    subject: 'Your {brand} mail-out is now in production', preheader: 'Your campaign is being prepared for printing and distribution.', kicker: 'Mail-out update', headline: 'Your campaign is being produced.', sub: '',
    intro: 'Your {brand} mail campaign has moved into production.', outro: '', cta: 'View campaign', whyTitle: 'What happens next', why: 'We will keep you updated as your campaign moves from production to post and delivery.' },
  mailout_posted: { label: 'Mail-out: posted', group: 'Mail-out status', vars: ['first', 'campaign', 'brand'],
    subject: 'Your {brand} mail-out has been posted', preheader: 'Your campaign is officially on its way.', kicker: 'Your mail is on the move', headline: 'Your campaign has been posted.', sub: '',
    intro: 'Your {brand} campaign has now been posted.', outro: '', cta: 'Watch my campaign', whyTitle: 'What happens next', why: `As ${CLIENT_NOUN}s begin interacting with your {brand} campaign, you will receive Warm Lead, Hot Lead and Call Request notifications.` },
  mailout_delivery: { label: 'Mail-out: delivery window', group: 'Mail-out status', vars: ['first', 'campaign', 'brand'],
    subject: 'Your mail-out should be reaching homes now', preheader: `Watch your portal for incoming ${CLIENT_NOUN} activity.`, kicker: 'Delivery window', headline: `Your campaign should now be reaching ${CLIENT_NOUN}s.`, sub: '',
    intro: 'Your {brand} mail campaign is now within its estimated delivery window.', outro: '', cta: 'View live activity', whyTitle: 'What happens next', why: 'This is when things get interesting. Watch for Warm Leads, Hot Leads and Call Requests as they respond.' },
  test: { label: 'Test email (Notifications page)', group: 'Account', vars: ['first', 'email', 'brand'],
    subject: '{brand} test email', preheader: 'Your email alerts are working.', kicker: 'Test', headline: 'Email alerts are working.', sub: '',
    intro: 'This is a test from your Notifications page. If you can read this, lead alerts will reach {email}.', outro: '', cta: `Back to my ${PORTAL_LABEL.toLowerCase()}`, whyTitle: '', why: '' },
};
let tplCache = { at: 0, data: {} };
let previewOverrides = null;                       // set by the founders' preview / test send
function setPreviewOverrides(map) { previewOverrides = map || null; }
async function loadTemplateOverrides(force) {
  if (!force && Date.now() - tplCache.at < 60000) return tplCache.data;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/email_templates?select=key,fields`, { headers: sbHeaders() });
    const rows = res.ok ? await res.json() : [];
    const data = {}; rows.forEach((r) => { data[r.key] = r.fields || {}; });
    tplCache = { at: Date.now(), data };
  } catch (e) { console.error('email_templates load failed', e); }
  return tplCache.data;
}
const fill = (str, vars) => String(str == null ? '' : str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
async function tpl(key, vars = {}) {
  const d = TEMPLATE_DEFAULTS[key] || {};
  const ov = previewOverrides ? (previewOverrides[key] || {}) : ((await loadTemplateOverrides())[key] || {});
  const v = { brand: BRAND, portal: PORTAL_URL, ...vars };
  const out = {};
  TEMPLATE_FIELDS.forEach((f) => { out[f] = fill(ov[f] !== undefined && ov[f] !== null && String(ov[f]).trim() !== '' ? ov[f] : d[f], v); });
  return out;
}
const hi = (agent) => P(`Hi ${esc(firstName(agent))},`);
const para = (t) => (t && String(t).trim() ? P(esc(t)) : '');
function assemble(t, body, extra = {}) {
  return { subject: t.subject, html: shell({ preheader: t.preheader, kicker: t.kicker, headline: esc(t.headline), sub: esc(t.sub), body, cta: t.cta, ctaHref: extra.ctaHref, whyTitle: t.whyTitle, why: esc(t.why), unsubNote: extra.unsubNote !== undefined ? extra.unsubNote : true }) };
}

/* 02 · Client requesting a call  /  03 · New hot lead */
async function hotEmail(lead, isCall, agent) {
  const tel = String(lead.mobile || '').replace(/[^\d+]/g, '');
  const clientName = lead.full_name || `A ${CLIENT_NOUN}`;
  const t = await tpl(isCall ? 'call' : 'hot', { first: firstName(agent), clientName, address: lead.address || `new ${LEAD_NOUN}`, mobile: lead.mobile || '' });
  const rows = [['Name', lead.full_name], ['Mobile', lead.mobile], ['Email', lead.email], ['Prefers', lead.contact_preference], ['Home', homeLine(lead)], ...extraRows(lead), ['Features', (lead.features_selected || []).join(', ') || null], [isCall ? 'Requested' : 'Completed', fmtWhen(lead.created_at)], sourceRow(lead, agent) || ['', '']];
  const body = `${hi(agent)}${para(t.intro)}${propertyBox('Property', lead.address, rows)}
    ${isCall && lead.mobile ? `<a href="tel:${esc(tel)}" style="display:inline-block; background:${INK}; color:#fff; text-decoration:none; font-weight:800; font-size:15px; padding:12px 20px; border-radius:100px; margin:0 0 16px;">📞 Call ${esc(lead.mobile)}</a>` : ''}
    ${para(t.outro)}${photoList(lead.photos)}${notesBlock(lead)}`;
  return assemble(t, body);
}
/* 04 · New warm lead */
async function warmEmail(lead, agent) {
  const photos = Array.isArray(lead.photos) ? lead.photos : [];
  const t = await tpl('warm', { first: firstName(agent), address: lead.address || `new ${LEAD_NOUN}`, photos: photos.length });
  const body = `${hi(agent)}${para(t.intro)}
    ${propertyBox('Property', lead.address, [['Started', fmtWhen(lead.created_at)], ['Photos uploaded', String(photos.length)], ['Status', `${CAP(LEAD_NOUN)} in progress`], sourceRow(lead, agent) || ['', '']])}
    ${para(t.outro)}${photoList(photos)}${notesBlock(lead)}`;
  return assemble(t, body);
}
/* 05 · Hot lead locked */
async function lockedEmail(lead, hotCount, agent) {
  const t = await tpl('locked', { first: firstName(agent), address: lead.address || '', hotCount, freeLimit: FREE_LIMIT });
  const body = `${hi(agent)}${para(t.intro)}
    ${propertyBox('New opportunity', lead.address, [['Received', fmtWhen(lead.created_at)], ['Status', 'LOCKED'], sourceRow(lead, agent) || ['', '']])}
    ${para(t.outro)}`;
  return assemble(t, body, { ctaHref: PORTAL_URL });
}
/* 06 · Weekly summary */
async function weeklyEmail(agent, stats) {
  const cell = (label, n) => `<tr><td style="padding:9px 0; border-bottom:1px solid #EEECE6; font-size:14px; color:#444;">${esc(label)}</td><td align="right" style="padding:9px 0; border-bottom:1px solid #EEECE6; font-size:18px; font-weight:800; color:${INK};">${n}</td></tr>`;
  const total = (stats.hot || 0) + (stats.warm || 0);
  const t = await tpl('weekly', { first: firstName(agent), total, pending: stats.pending || 0, weekStart: stats.weekStart || '', weekEnd: stats.weekEnd || '' });
  const body = `${P(`Morning ${esc(firstName(agent))},`)}${para(t.intro)}
    <div style="font-size:12px; color:#999; margin-bottom:6px;">${esc(stats.weekStart || '')} – ${esc(stats.weekEnd || '')}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
      ${cell('Hot leads', stats.hot || 0)}${cell('Warm leads', stats.warm || 0)}${cell('Call requests', stats.calls || 0)}${cell(`${CAP(LEAD_NOUN)}s started`, stats.started || 0)}${cell(`${CAP(LEAD_NOUN)}s completed`, stats.hot || 0)}${cell('Property photos uploaded', stats.photos || 0)}
    </table>
    ${stats.topAddress ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr><td style="background:#F7F6F3; border-radius:12px; padding:14px 16px;"><div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase;">Strongest opportunity this week</div><div style="font-size:15px; font-weight:800; color:${INK}; margin-top:4px;">${esc(stats.topAddress)}</div><div style="font-size:13px; color:#666; margin-top:2px;">Status: ${esc(stats.topStatus || '')} &nbsp;|&nbsp; Activity: ${esc(stats.topActivity || '')}</div></td></tr></table>` : ''}
    <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:${ACCENT}; text-transform:uppercase;">Your total opportunity</div>
    ${P(`<b>${total}</b> ${CLIENT_NOUN}${total === 1 ? '' : 's'} showed property intent this week.${stats.pending ? ` <b>${stats.pending}</b> hot lead${stats.pending === 1 ? ' has' : 's have'} not been marked as appraised yet.` : ''}`)}
    ${para(t.outro)}`;
  return assemble(t, body);
}
/* 01 · Welcome (sent once, at signup) */
async function welcomeEmail(agent) {
  const t = await tpl('welcome', { first: firstName(agent) });
  const pillar = (tag, title, text) => `<tr><td style="padding:10px 0; border-bottom:1px solid #EEECE6;"><div style="font-size:10.5px; font-weight:800; letter-spacing:0.14em; color:${ACCENT}; text-transform:uppercase;">${esc(tag)}</div><div style="font-size:15px; font-weight:800; color:${INK}; margin:2px 0;">${esc(title)}</div><div style="font-size:13.5px; color:#555; line-height:1.5;">${esc(text)}</div></td></tr>`;
  const body = `${hi(agent)}${para(t.intro)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">
      ${pillar('Smart', 'See intent, not just names.', `Identify ${CLIENT_NOUN}s actively engaging with their property, requesting ${AN_LEAD} or asking to speak with ${AN_AGENT}.`)}
      ${pillar('Bold', 'Stand out in your marketplace.', `Give ${CLIENT_NOUN}s an easy, modern ${LEAD_NOUN} experience while positioning yourself as the local ${AGENT_NOUN} ready to help.`)}
      ${pillar('Fast', 'Know when opportunity happens.', `Receive alerts when ${CLIENT_NOUN}s start, upload photos, complete ${AN_LEAD}, provide details or request a call.`)}
      ${pillar('Trustworthy', `Professional for ${CLIENT_NOUN}s. Powerful for ${AGENT_NOUN}s.`, `Create a simple, credible ${CLIENT_NOUN} experience while receiving clearer signals about potential ${WIN_NOUN === 'listing' ? 'selling' : 'leasing'} intent.`)}
    </table>
    <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase; margin-bottom:6px;">Your portal</div>
    <ul style="padding-left:18px; margin:0 0 16px; font-size:14px; color:#333; line-height:1.7;"><li>View new leads</li><li>See ${LEAD_NOUN} activity</li><li>Review ${CLIENT_NOUN} details</li><li>Track warm and hot opportunities</li><li>Campaign QR codes, analytics and the portal app on your phone</li><li>Manage your account and subscription</li></ul>
    ${para(t.outro)}`;
  return assemble(t, body, { unsubNote: false });
}
/* 08 · Launch giveaway (SAVETIME) reminders + end */
async function trialEmail(agent, stage, info = {}) {
  const key = stage === '5' ? 'trial5' : stage === '1' ? 'trial1' : 'trialend';
  const t = await tpl(key, { first: firstName(agent), daysLeft: info.daysLeft != null ? info.daysLeft : '', trialEnds: info.trialEnds || '' });
  const body = `${hi(agent)}${para(t.intro)}
    ${key !== 'trialend' ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px;"><tr><td style="background:#F7F6F3; border-radius:12px; padding:14px 16px;"><div style="font-size:11px; font-weight:800; letter-spacing:0.12em; color:#999; text-transform:uppercase;">Full Access ends</div><div style="font-size:17px; font-weight:800; color:${INK}; margin-top:4px;">${esc(info.trialEnds || '')}</div><div style="font-size:13px; color:#666; margin-top:2px;">Monthly $49 · 6 months $245 (1 month free) · 12 months $490 (2 months free)</div></td></tr></table>` : ''}
    ${para(t.outro)}`;
  return assemble(t, body, { ctaHref: PORTAL_URL, unsubNote: false });
}
/* 09 · Referral reward */
async function referralRewardEmail(agent, referredName) {
  const t = await tpl('referral_reward', { first: firstName(agent), referredName: referredName || `A ${AGENT_NOUN}` });
  const body = `${hi(agent)}${para(t.intro)}${para(t.outro)}`;
  return assemble(t, body, { ctaHref: PORTAL_URL, unsubNote: false });
}
/* 07 · Mail-out status */
async function mailoutEmail(agent, stage, c = {}) {
  const status = { production: 'IN PRODUCTION', posted: 'POSTED', delivery: 'DELIVERING' }[stage];
  if (!status) return null;
  const t = await tpl('mailout_' + stage, { first: firstName(agent), campaign: c.name || 'Your campaign' });
  const body = `${hi(agent)}${para(t.intro)}${propertyBox('Campaign', c.name || 'Your campaign', [['Area', c.area], ['Quantity', c.quantity], ['Posted', c.posted], ['Estimated delivery', c.delivery], ['Status', status]])}${para(t.outro)}`;
  return assemble(t, body);
}
async function testEmail(agent) {
  const t = await tpl('test', { first: firstName(agent), email: agent.email });
  const body = `${hi(agent)}${para(t.intro)}${para(t.outro)}`;
  return assemble(t, body);
}
// Sample data so founders can preview / test-send any template
async function sampleEmail(key, agent) {
  const a = { ...agent, agent_name: agent.agent_name || 'Sam Agent', trial_active: true };
  const lead = { id: 'sample', address: '23 Waterworks Rd, The Gap QLD 4061', full_name: 'Sarah O’Connell', mobile: '0412 345 678', email: 'sarah@example.com', contact_preference: key === 'call' ? 'Call' : 'Email', bedroom_count: 4, bathroom_count: 2, car_spaces: 2, features_selected: ['Pool', 'Solar panels'], created_at: new Date().toISOString(), source_channel: 'postcard', source_name: 'Spring postcard drop', photos: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', room: 'Front of house', note: 'New fence last year' }, { url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', room: 'Kitchen' }], room_notes: [] };
  const ends = new Date(Date.now() + 5 * 86400000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', timeZone: 'Australia/Brisbane' });
  switch (key) {
    case 'call': return hotEmail(lead, true, a);
    case 'hot': return hotEmail(lead, false, a);
    case 'warm': return warmEmail({ ...lead, lead_type: 'Cold Lead', full_name: null, mobile: null, email: null }, a);
    case 'locked': return lockedEmail(lead, 4, a);
    case 'weekly': return weeklyEmail(a, { hot: 3, warm: 5, calls: 1, started: 8, photos: 41, pending: 2, weekStart: '14 Sept', weekEnd: '20 Sept', topAddress: lead.address, topStatus: 'Hot lead', topActivity: '11 photos, call requested' });
    case 'welcome': return welcomeEmail(a);
    case 'trial5': return trialEmail(a, '5', { daysLeft: 5, trialEnds: ends });
    case 'trial1': return trialEmail(a, '1', { daysLeft: 1, trialEnds: ends });
    case 'trialend': return trialEmail(a, 'end', {});
    case 'referral_reward': return referralRewardEmail(a, 'Jane Smith');
    case 'mailout_production': return mailoutEmail(a, 'production', { name: 'Ashgrove spring drop', area: '4060 Ashgrove', quantity: '500' });
    case 'mailout_posted': return mailoutEmail(a, 'posted', { name: 'Ashgrove spring drop', area: '4060 Ashgrove', quantity: '500', posted: 'Today' });
    case 'mailout_delivery': return mailoutEmail(a, 'delivery', { name: 'Ashgrove spring drop', area: '4060 Ashgrove', quantity: '500', posted: '2 days ago', delivery: 'This week' });
    default: return testEmail(a);
  }
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
      const { subject, html } = await hotEmail(lead, isCall, agent);
      await notify({ agent, kind, leadId: lead.id, subject, html });

      // Free-plan limit: only the FREE_LIMIT most recent hot leads are unlocked
      const hasAccess = !!agent.trial_active || agent.subscription_status === 'active';
      if (!hasAccess) {
        const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leads?agent_id=eq.${agent.id}&lead_type=eq.Hot%20Lead&banked=not.is.true&select=id`, { headers: sbHeaders({ Prefer: 'count=exact' }) });
        const hotCount = res.ok ? (await res.json()).length : 0;
        if (hotCount > FREE_LIMIT) {
          const t = await lockedEmail(lead, hotCount, agent);
          await notify({ agent, kind: 'locked', leadId: lead.id, subject: t.subject, html: t.html });
        }
      }
      return;
    }

    // Warm lead: alert once, the first time a photo lands (address alone is too early)
    if (photos.length >= 1) {
      const { subject, html } = await warmEmail(lead, agent);
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
    const { subject, html } = await welcomeEmail(agent);
    const r = await sendEmail({ to: agent.email, subject, html });
    await log({ agent_id: agent.id, kind: 'welcome', to_email: agent.email, subject, status: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'), error: r.ok ? null : r.error, provider_id: r.id || null });
  } catch (e) { console.error('welcome email failed (non-fatal)', e); }
}

module.exports = { shell, esc, P, firstName, notify, notifyForLead, sendEmail, trialEmail, referralRewardEmail, sampleEmail, TEMPLATE_DEFAULTS, TEMPLATE_FIELDS, setPreviewOverrides, loadTemplateOverrides, getAgent, wantsEmail, weeklyEmail, welcomeEmail, sendWelcome, mailoutEmail, hotEmail, warmEmail, lockedEmail, testEmail, NOTIFY_DEFAULTS, sbHeaders, log };
