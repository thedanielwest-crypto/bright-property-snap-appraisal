// netlify/functions/agent-subscription.js
//
// Manual plan-set endpoint — kept for admin/testing use. The real upgrade
// path for agents is now stripe-checkout.js -> Stripe Checkout ->
// stripe-webhook.js, which updates the plan automatically on payment.

function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

const VALID_PLANS = ['Standard', 'Premium', 'Platinum'];

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

  const { agentId, plan } = payload;
  if (!agentId || !VALID_PLANS.includes(plan)) {
    return { statusCode: 400, body: 'agentId and a valid plan (Standard/Premium/Platinum) are required' };
  }

  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}`, {
      method: 'PATCH',
      headers: sbHeaders(),
      body: JSON.stringify({ plan, trial_active: false }),
    });
    if (!res.ok) {
      console.error('agent-subscription update error:', res.status, await res.text());
      return { statusCode: 502, body: 'Failed to update plan' };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, plan }) };
  } catch (err) {
    console.error('agent-subscription error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
