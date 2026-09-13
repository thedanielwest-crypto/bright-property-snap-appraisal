// netlify/functions/send-lead-email.js
//
// "Send it to me": emails a lead (warm or hot) to the agent's own inbox as a
// proper HTML email, so every photo is a real hyperlink whose text is the
// room name, e.g. KITCHEN, MAIN BEDROOM, FRONT OF HOUSE.
//
// Uses Resend (https://resend.com), free tier is plenty to start.
// Requires:
//   RESEND_API_KEY   = re_...
//   LEAD_EMAIL_FROM  = e.g. "Snap Appraisal <leads@austsnapappraisal.com>"
//                      (domain must be verified in Resend; until then use
//                       "Snap Appraisal <onboarding@resend.dev>" for testing)
// If RESEND_API_KEY is missing the function answers 503 and the portal falls
// back to opening a plain mailto instead, so nothing breaks.

function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!process.env.RESEND_API_KEY) return { statusCode: 503, body: 'Email service not configured (RESEND_API_KEY)' };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return { statusCode: 500, body: 'Supabase not configured' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { agentId, leadId } = payload;
  if (!agentId || !leadId) return { statusCode: 400, body: 'agentId and leadId are required' };

  try {
    const [agentRes, leadRes] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}&select=agent_name,email`, { headers: sbHeaders() }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}&agent_id=eq.${agentId}&select=*`, { headers: sbHeaders() }),
    ]);
    const agent = (await agentRes.json())[0];
    const lead = (await leadRes.json())[0];
    if (!agent || !lead) return { statusCode: 404, body: 'Lead not found for this agent' };

    const isWarm = lead.lead_type !== 'Hot Lead';
    const photos = Array.isArray(lead.photos) ? lead.photos : [];
    const photoLinks = photos
      .map((p, i) => (typeof p === 'string' ? { url: p, room: `Photo ${i + 1}` } : p))
      .filter((p) => p && p.url)
      .map((p, i) => `<li style="margin:6px 0;"><a href="${esc(p.url)}" style="color:#FF5A1F; font-weight:700; text-decoration:underline;">${esc((p.room || `Photo ${i + 1}`).toUpperCase())}</a></li>`)
      .join('');

    const row = (label, value) => `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px; white-space:nowrap; vertical-align:top;">${label}</td><td style="padding:6px 0; font-size:14px;">${esc(value || 'Not given')}</td></tr>`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif; max-width:560px; margin:0 auto; color:#0D0D0D;">
        <div style="font-size:11px; letter-spacing:0.12em; color:#FF5A1F; font-weight:700;">SNAP APPRAISAL · ${isWarm ? 'WARM LEAD' : 'HOT LEAD'}</div>
        <h2 style="margin:6px 0 14px; font-size:22px;">${esc(lead.address || '(no address yet)')}</h2>
        ${!isWarm && String(lead.contact_preference || '').toLowerCase() === 'call' && lead.mobile
          ? `<div style="background:#FF5A1F; color:#fff; border-radius:10px; padding:12px 14px; font-weight:700; margin:0 0 14px;">📞 CLIENT REQUESTING A CALL · <a href="tel:${esc(String(lead.mobile).replace(/[^\d+]/g, ''))}" style="color:#fff;">${esc(lead.mobile)}</a></div>`
          : ''}
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:18px;">
          ${isWarm
            ? row('Status', 'Started but not finished yet, no contact details')
            : row('Name', lead.full_name) + row('Mobile', lead.mobile) + row('Email', lead.email) + row('Prefers', lead.contact_preference) + row('Bedrooms', lead.bedroom_count) + row('Features', (lead.features_selected || []).join(', ') || 'None selected')}
          ${row(isWarm ? 'Started' : 'Completed', new Date(lead.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }))}
          ${row('Rooms photographed', String(photos.length))}
        </table>
        <div style="font-size:13px; color:#888; margin-bottom:6px;">Photos, tap a room to open it:</div>
        <ul style="padding-left:18px; margin:0 0 22px;">${photoLinks || '<li style="color:#999;">No photos yet</li>'}</ul>
        <div style="font-size:11px; color:#999;">Sent from your Snap Appraisal Agent Portal · <a href="https://portal.austsnapappraisal.com" style="color:#999;">portal.austsnapappraisal.com</a></div>
      </div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.LEAD_EMAIL_FROM || 'Snap Appraisal <onboarding@resend.dev>',
        to: [agent.email],
        subject: `${isWarm ? 'Warm' : 'Hot'} lead: ${lead.address || 'new appraisal'}`,
        html,
      }),
    });
    if (!res.ok) {
      console.error('Resend error:', res.status, await res.text());
      return { statusCode: 502, body: 'Email send failed' };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('send-lead-email error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
