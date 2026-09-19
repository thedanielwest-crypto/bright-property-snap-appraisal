// netlify/functions/submit-lead.js
//
// Handles both stages of the Snap Appraisal flow:
//   1. COLD LEAD — fired the moment someone enters their address on the
//      Front of House step.
//   2. HOT LEAD — fired when someone completes the final "Appraise It" form.
//
// Writes to two places:
//   - Airtable (unconditionally, unchanged from how this has always worked)
//     — this is Bright Property / Rob's original flow and its automations,
//     left exactly as-is so nothing about his working setup changes.
//   - Supabase (only when an agentId is present) — this is what powers the
//     new multi-agent portal's Cold/Hot Listings pages, which read from
//     Supabase's "leads" table, not Airtable.
//
// Requires:
//   AIRTABLE_API_KEY          = Personal Access Token, data.records:write
//   SUPABASE_URL              = only needed once agents beyond Rob exist
//   SUPABASE_SERVICE_ROLE_KEY = only needed once agents beyond Rob exist
//   RESEND_API_KEY + LEAD_EMAIL_FROM = email alerts to the agent (see lib/notify.js)
//
// After the Supabase save the agent is emailed according to their Notifications
// preferences: call request, hot lead, warm lead (first photo), or "lead
// locked" on the free plan. Email only; de-duplicated per lead in lib/notify.js.

require('dns').setDefaultResultOrder('ipv4first');
const { rateLimit, clientIp, validEmail } = require('./lib/ratelimit');
const { notifyForLead } = require('./lib/notify');

const BASE_ID = 'appiGi6bBUSFYDLha';
const LEADS_TABLE_ID = 'tblmj5PyEAfZwPHOP';

const FIELDS = {
  fullName: 'fld1xN2C56LeLJdUL',
  status: 'fldDr9YPPXNjt2Ozk',
  mobile: 'fldED0xkBJWkWRKY1',
  address: 'fldwjLEJSFxkBvNsc',
  email: 'fld4VMmFd4hqVlhOc',
  contactPreference: 'fldT3zw3sDJSJBxt7',
  featuresSelected: 'fldfy5ah12KTMS85p',
  roomsPhotographed: 'fldgEYCPjjNHIJwRT',
  photos: 'fldySYt7rne1odBpl',
  sessionId: 'fldglYPMMCh35TA1I',
  notes: 'fldHdHOypmt319ifV',
};

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

function sbHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Best-effort — a Supabase hiccup should never break the Airtable-backed
// flow real agents already depend on, so every error here is swallowed
// after logging rather than failing the whole request.
async function upsertSupabaseLead({ agentId, sessionId, leadType, address, fullName, email, mobile, contactPreference, featuresSelected, photos, consent, marketingConsent, bedrooms, bathrooms, carSpaces }) {
  if (!agentId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const findRes = await fetchWithRetry(
      `${process.env.SUPABASE_URL}/rest/v1/leads?agent_id=eq.${agentId}&session_id=eq.${encodeURIComponent(sessionId || '')}&select=id`,
      { headers: sbHeaders() }
    );
    const existing = findRes && findRes.ok ? await findRes.json() : [];

    const fields = {
      agent_id: agentId,
      session_id: sessionId || '',
      lead_type: leadType,
      status: leadType === 'Hot Lead' ? 'Submitted' : 'In Progress',
      address: address || '',
    };
    if (fullName) fields.full_name = fullName;
    if (email) fields.email = email;
    if (mobile) fields.mobile = mobile;
    if (contactPreference) fields.contact_preference = contactPreference;
    const count = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(50, Math.round(Number(v)))) : null);
    if (count(bedrooms) !== null) fields.bedroom_count = count(bedrooms);
    if (count(bathrooms) !== null) fields.bathroom_count = count(bathrooms);
    if (count(carSpaces) !== null) fields.car_spaces = count(carSpaces);
    if (Array.isArray(featuresSelected)) fields.features_selected = featuresSelected;
    if (Array.isArray(photos)) {
      fields.rooms_photographed = photos.length;
      fields.photos = photos.map((p) => ({ room: p.room || '', url: p.url }));
    }
    // Consent evidence: recorded when the client accepted the disclosure screen
    if (consent && consent.at) {
      fields.consent_at = consent.at;
      fields.consent_version = String(consent.version || '').slice(0, 60);
    }
    if (typeof marketingConsent === 'boolean') {
      fields.marketing_consent = marketingConsent;
      if (marketingConsent) fields.marketing_consent_at = new Date().toISOString();
    }

    let res;
    if (existing.length) {
      res = await fetchWithRetry(`${process.env.SUPABASE_URL}/rest/v1/leads?id=eq.${existing[0].id}`, {
        method: 'PATCH',
        headers: sbHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify(fields),
      });
    } else {
      res = await fetchWithRetry(`${process.env.SUPABASE_URL}/rest/v1/leads`, {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify(fields),
      });
    }
    if (!res || !res.ok) { console.error('Supabase lead upsert error:', res && res.status); return; }
    const rows = await res.json();
    const saved = rows && rows[0];
    // Email the agent (preferences + de-duplication handled inside; never throws)
    if (saved) await notifyForLead(saved, { isNew: !existing.length });
  } catch (err) {
    console.error('Supabase lead upsert failed (non-fatal):', err);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }
  // Abuse control: 60 lead syncs per IP per 10 minutes (a normal walk-through makes ~15)
  const rl = await rateLimit(`lead:${clientIp(event)}`, 60, 10 * 60);
  if (rl.blocked) return rl.response;
  if (payload.email && !validEmail(payload.email)) {
    return { statusCode: 400, body: 'Please enter a valid email address' };
  }

  const {
    sessionId,
    recordId,       // present on the Hot Lead call if a Cold Lead record already exists
    leadType,        // 'Cold Lead' | 'Hot Lead'
    fullName,
    email,
    mobile,
    contactPreference,
    address,
    featuresSelected,
    photos,
    agentId,        // present once this link belongs to an agent beyond Rob
    bedrooms, bathrooms, carSpaces,   // owner-confirmed counts from the final form
    consent,        // {at, version, agentId} from the disclosure screen
    marketingConsent,
  } = payload;

  // Start the Supabase write + agent email now and let it run alongside the
  // Airtable save; we wait for it just before responding so the email is
  // actually sent before the function is frozen. It can never break the
  // Airtable-backed response below (every error inside is swallowed).
  const supabaseWork = upsertSupabaseLead({ agentId, sessionId, leadType, address, fullName, email, mobile, contactPreference, featuresSelected, photos, consent, marketingConsent, bedrooms, bathrooms, carSpaces });

  const noteLines = [];
  if (leadType) noteLines.push(`[${leadType}]`);

  const fields = {
    [FIELDS.address]: address || '',
    [FIELDS.sessionId]: sessionId || '',
    [FIELDS.notes]: noteLines.join(' '),
  };
  if (fullName) fields[FIELDS.fullName] = fullName;
  if (email) fields[FIELDS.email] = email;
  if (mobile) fields[FIELDS.mobile] = mobile;
  if (contactPreference) fields[FIELDS.contactPreference] = contactPreference;
  if (Array.isArray(featuresSelected)) fields[FIELDS.featuresSelected] = featuresSelected;
  if (Array.isArray(photos)) {
    fields[FIELDS.roomsPhotographed] = photos.length;
    fields[FIELDS.photos] = photos.map((p) => ({ url: p.url }));
  }
  fields[FIELDS.status] = leadType === 'Hot Lead' ? 'Submitted' : 'In Progress';

  try {
    let res, isUpdate = false;

    if (recordId) {
      // HOT LEAD — update the existing Cold Lead record
      isUpdate = true;
      res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: [{ id: recordId, fields }], typecast: true }),
      });
    } else {
      // COLD LEAD (or a Hot Lead with no prior cold record) — create new
      res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error('Airtable error:', res.status, errText);
      await supabaseWork;
      return { statusCode: 502, body: 'Failed to save lead' };
    }

    const data = await res.json();
    const savedId = isUpdate ? recordId : data.records[0].id;
    await supabaseWork;
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, recordId: savedId }),
    };
  } catch (err) {
    console.error('submit-lead error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
