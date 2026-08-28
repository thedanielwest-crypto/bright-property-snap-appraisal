// netlify/functions/agent-login.js
//
// Real agent authentication against Supabase's "agents" table via its
// REST API (PostgREST). Uses the service_role/secret key server-side only
// — this key bypasses Row Level Security entirely, so it must never reach
// any browser-facing code.
//
// Security note (same as before): this still returns a bare record ID as
// the session token, with no signing/expiry/HttpOnly cookie. Fine for a
// working prototype with real agents starting to log in, not yet real
// production session security — swap for Supabase Auth or signed JWTs
// before this scales past a handful of agents.
//


const crypto = require('crypto');

const SMART_CODES = {
  BASIC26: 'Standard',
  BEST26: 'Premium',
  SUPERB26: 'Platinum',
};

function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored_ = Buffer.from(hashHex, 'hex');
  if (candidate.length !== stored_.length) return false;
  return crypto.timingSafeEqual(candidate, stored_);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: 'Supabase not configured yet (missing env vars)' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const email = (payload.email || '').trim().toLowerCase();
  const password = payload.password || '';
  const smartCode = (payload.smartCode || '').trim().toUpperCase();

  if (!email || !password) {
    return { statusCode: 400, body: 'Email and password are required' };
  }

  try {
    const findRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/agents?email=eq.${encodeURIComponent(email)}&select=*`,
      { headers: sbHeaders() }
    );
    if (!findRes.ok) {
      console.error('Supabase lookup error:', findRes.status, await findRes.text());
      return { statusCode: 502, body: 'Lookup failed' };
    }
    const rows = await findRes.json();
    if (!rows.length) {
      return { statusCode: 401, body: 'No account found for that email' };
    }
    const agent = rows[0];

    if (!verifyPassword(password, agent.password_hash)) {
      return { statusCode: 401, body: 'Incorrect password' };
    }

    let smartCodeError = null;
    let finalPlan = agent.plan;
    let trialActive = agent.trial_active;

    if (smartCode) {
      if (SMART_CODES[smartCode]) {
        finalPlan = SMART_CODES[smartCode];
        trialActive = true;
        const updateRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agent.id}`,
          {
            method: 'PATCH',
            headers: sbHeaders(),
            body: JSON.stringify({
              plan: finalPlan,
              trial_active: true,
              trial_started: new Date().toISOString().slice(0, 10),
            }),
          }
        );
        if (!updateRes.ok) {
          console.error('Failed to apply SMART CODE:', await updateRes.text());
          finalPlan = agent.plan;
          trialActive = agent.trial_active;
        }
      } else {
        smartCodeError = 'SMART CODE not recognised';
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        agentId: agent.id,
        name: agent.agent_name,
        agencyName: agent.agency_name || '',
        slug: agent.slug || '',
        plan: finalPlan,
        trialActive,
        logoUrl: agent.logo_url || '',
        headshotUrl: agent.headshot_url || '',
        brandColor: agent.brand_color || '#FF5A1F',
        referralCode: agent.referral_code || '',
        smartCodeError,
      }),
    };
  } catch (err) {
    console.error('agent-login error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
