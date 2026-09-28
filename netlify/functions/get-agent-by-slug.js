// netlify/functions/get-agent-by-slug.js
//
// Looks up an agent's public branding info (name, agency, contact details,
// logo, colour) by their URL slug — e.g. austsnapappraisal.com/sarahchen
// calls this with slug=sarahchen to find out whose app this is.
//
// Only returns public-facing fields — never password_hash, Stripe IDs, etc.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same values as the
// Agent Portal site — these need to be added here too since environment
// variables don't carry over between separate Netlify sites).

require('dns').setDefaultResultOrder('ipv4first');

function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

async function fetchWithRetry(url, options, retries = 2, delayMs = 400) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      console.error(`fetch attempt ${attempt + 1} failed, retrying:`, err.message);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: 'Supabase not configured yet (missing env vars)' };
  }

  const slug = (event.queryStringParameters && event.queryStringParameters.slug || '')
    .trim()
    .toLowerCase();
  if (!slug) {
    return { statusCode: 400, body: 'slug is required' };
  }

  try {
    const res = await fetchWithRetry(
      `${process.env.SUPABASE_URL}/rest/v1/agents?slug=eq.${encodeURIComponent(slug)}&select=id,agent_name,agency_name,email,phone,logo_url,headshot_url,brand_color,stat_homes,stat_avg_days,stat_local_tag,intro_statement,tagline,finish_url`,
      { headers: sbHeaders() }
    );
    if (!res.ok) {
      console.error('get-agent-by-slug lookup error:', res.status, await res.text());
      return { statusCode: 502, body: 'Lookup failed' };
    }
    const rows = await res.json();
    if (!rows.length) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, message: 'No agent found for that link' }) };
    }
    const a = rows[0];
    // Where the "Finish" button sends the client at the end: the campaign's own
    // destination (agent's QR-swap use case) or the agent's default finish link.
    let finishUrl = a.finish_url || '';
    const code = String((event.queryStringParameters && event.queryStringParameters.c) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (code) {
      try {
        const cr = await fetchWithRetry(`${process.env.SUPABASE_URL}/rest/v1/campaigns?agent_id=eq.${a.id}&code=eq.${code}&select=destination_url&limit=1`, { headers: sbHeaders() });
        const crow = cr.ok ? (await cr.json())[0] : null;
        if (crow && crow.destination_url) finishUrl = crow.destination_url;
      } catch (e) { /* fall back to the agent default */ }
    }
    if (!/^https?:\/\//i.test(finishUrl)) finishUrl = '';
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        agentId: a.id,
        agentName: a.agent_name,
        agencyName: a.agency_name || '',
        email: a.email,
        phone: a.phone || '',
        logoUrl: a.logo_url || '',
        headshotUrl: a.headshot_url || '',
        brandColor: a.brand_color || '#FF5A1F',
        statHomes: a.stat_homes || '150+',
        statAvgDays: a.stat_avg_days || '11 days',
        statLocalTag: a.stat_local_tag || 'Local',
        introStatement: a.intro_statement || '',
        tagline: a.tagline || '',
        finishUrl,
      }),
    };
  } catch (err) {
    console.error('get-agent-by-slug error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
