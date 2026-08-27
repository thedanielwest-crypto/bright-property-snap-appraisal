// netlify/functions/stripe-webhook.js
//
// Listens for Stripe events. On checkout.session.completed, activates the
// agent's plan in Supabase — this is the moment payment actually succeeded.
//
// Setup still needed (see the README note below): register this URL as a
// webhook endpoint in the Stripe dashboard, then paste the signing secret
// it gives you into Netlify as STRIPE_WEBHOOK_SECRET.
//
// Signature verification is done by hand with Node's built-in crypto —
// no Stripe SDK dependency needed, consistent with every other function
// in this project.

const crypto = require('crypto');

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => p.split('=').map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return { statusCode: 500, body: 'Webhook not configured yet (missing STRIPE_WEBHOOK_SECRET)' };
  }

  const sig = event.headers['stripe-signature'];
  const rawBody = event.body;

  if (!verifyStripeSignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error('Stripe webhook signature verification failed');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const agentId = session.metadata && session.metadata.agentId;
      const plan = session.metadata && session.metadata.plan;

      if (agentId && plan) {
        const updateRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}`,
          {
            method: 'PATCH',
            headers: sbHeaders(),
            body: JSON.stringify({
              plan,
              trial_active: false,
              stripe_customer_id: session.customer,
              stripe_subscription_id: session.subscription,
              subscription_status: 'active',
            }),
          }
        );
        if (!updateRes.ok) {
          console.error('Failed to activate plan after payment:', await updateRes.text());
        }
      } else {
        console.error('checkout.session.completed missing agentId/plan metadata');
      }
    }

    // Subscription cancelled or payment failed — switch the agent back to Standard
    // rather than leaving them on a paid tier they're no longer paying for.
    if (
      stripeEvent.type === 'customer.subscription.deleted' ||
      stripeEvent.type === 'invoice.payment_failed'
    ) {
      const obj = stripeEvent.data.object;
      const subscriptionId = obj.id || obj.subscription;
      if (subscriptionId) {
        const findRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/agents?stripe_subscription_id=eq.${subscriptionId}&select=id`,
          { headers: sbHeaders() }
        );
        const rows = findRes.ok ? await findRes.json() : [];
        if (rows.length) {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/agents?id=eq.${rows[0].id}`, {
            method: 'PATCH',
            headers: sbHeaders(),
            body: JSON.stringify({ plan: 'Standard', subscription_status: 'past_due' }),
          });
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
