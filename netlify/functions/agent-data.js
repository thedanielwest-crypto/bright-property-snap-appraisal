// netlify/functions/agent-data.js
//
// Returns an agent's Cold and Hot listings from Supabase's "leads" table,
// with hot-lead contact details revealed or locked according to plan.

function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function unlockedCount(plan, total) {
  if (plan === 'Platinum') return total;
  if (plan === 'Premium') return Math.min(total, 5);
  return Math.min(total, 2);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: 'Supabase not configured yet (missing env vars)' };
  }

  const agentId = event.queryStringParameters && event.queryStringParameters.agentId;
  if (!agentId) {
    return { statusCode: 400, body: 'agentId is required' };
  }

  try {
    const agentRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}&select=plan,trial_active`,
      { headers: sbHeaders() }
    );
    if (!agentRes.ok) return { statusCode: 404, body: 'Agent not found' };
    const agentRows = await agentRes.json();
    if (!agentRows.length) return { statusCode: 404, body: 'Agent not found' };
    const plan = agentRows[0].plan || 'Standard';
    const trialActive = !!agentRows[0].trial_active;

    const leadsRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/leads?agent_id=eq.${agentId}&select=*&order=created_at.desc`,
      { headers: sbHeaders() }
    );
    if (!leadsRes.ok) {
      console.error('Supabase leads fetch error:', leadsRes.status, await leadsRes.text());
      return { statusCode: 502, body: 'Failed to load leads' };
    }
    const leadRows = await leadsRes.json();

    const cold = leadRows.filter((l) => l.lead_type === 'Cold Lead')
      .map((l) => ({ id: l.id, address: l.address || '(no address yet)', createdTime: l.created_at }));
    const hot = leadRows.filter((l) => l.lead_type === 'Hot Lead')
      .map((l) => ({
        id: l.id,
        address: l.address || '',
        name: l.full_name || '',
        mobile: l.mobile || '',
        email: l.email || '',
        createdTime: l.created_at,
      }));

    const coldUnlocked = unlockedCount(plan, cold.length);
    const hotUnlocked = unlockedCount(plan, hot.length);

    const coldOut = cold.map((c, i) => ({ ...c, locked: i >= coldUnlocked }));
    const hotOut = hot.map((h, i) => {
      if (i < hotUnlocked) return { ...h, locked: false };
      return { id: h.id, address: h.address, locked: true };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        plan,
        trialActive,
        cold: coldOut,
        hot: hotOut,
        coldUnlocked,
        hotUnlocked,
        coldTotal: cold.length,
        hotTotal: hot.length,
      }),
    };
  } catch (err) {
    console.error('agent-data error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
