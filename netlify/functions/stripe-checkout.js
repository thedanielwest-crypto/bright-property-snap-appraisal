// netlify/functions/stripe-checkout.js
//
// Creates a Stripe Checkout Session for an agent upgrading their plan.
// Frontend calls this, gets back a URL, and redirects the browser there —
// Stripe's own hosted page handles the actual card entry, so we never
// see or store card details.
//
// Requires STRIPE_SECRET_KEY (test mode: starts with sk_test_).
// Price IDs below are real, already created in Stripe test mode tonight.

const PRICE_IDS = {
  Standard: 'price_1U9B0dJXXPaNS1ZbjDX910B4',
  Premium: 'price_1U9B0mJXXPaNS1Zby9acbyOS',
  Platinum: 'price_1U9B0sJXXPaNS1ZbH7bthvQM',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, body: 'Stripe not configured yet (missing STRIPE_SECRET_KEY)' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { agentId, plan, returnUrl } = payload;
  if (!agentId || !PRICE_IDS[plan]) {
    return { statusCode: 400, body: 'agentId and a valid plan (Standard/Premium/Platinum) are required' };
  }

  const base = returnUrl || 'https://austsnapappraisal.com/portal';

  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', PRICE_IDS[plan]);
  params.append('line_items[0][quantity]', '1');
  params.append('client_reference_id', agentId);
  params.append('metadata[agentId]', agentId);
  params.append('metadata[plan]', plan);
  params.append('success_url', `${base}?upgrade=success&plan=${plan}`);
  params.append('cancel_url', `${base}?upgrade=cancelled`);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('Stripe checkout session error:', res.status, errText);
      return { statusCode: 502, body: 'Failed to create checkout session' };
    }
    const session = await res.json();
    return { statusCode: 200, body: JSON.stringify({ ok: true, url: session.url }) };
  } catch (err) {
    console.error('stripe-checkout error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
