// netlify/functions/submit-lead.js
//
// Writes a completed Snap Your Appraisal submission into the real
// "Snap Appraisals" Airtable base (built 2026-08-10).
//
// Requires one environment variable, set in Netlify's dashboard under
// Site settings → Environment variables (never commit this to git):
//
//   AIRTABLE_API_KEY = <a Personal Access Token from airtable.com/create/tokens
//                        scoped to this base with data.records:write access>
//
// Base: Snap Appraisals (appiGi6bBUSFYDLha)
// Table: Leads (tblmj5PyEAfZwPHOP)

const BASE_ID = 'appiGi6bBUSFYDLha';
const LEADS_TABLE_ID = 'tblmj5PyEAfZwPHOP';

// Field IDs from the live base — do not rename these without updating the base too.
const FIELDS = {
  fullName: 'fld1xN2C56LeLJdUL',
  status: 'fldDr9YPPXNjt2Ozk',
  mobile: 'fldED0xkBJWkWRKY1',
  address: 'fldwjLEJSFxkBvNsc',
  contactPreference: 'fldT3zw3sDJSJBxt7',
  email: 'fld4VMmFd4hqVlhOc',
  bedroomCount: 'fldEsC0MjU1k6kclQ',
  featuresSelected: 'fldfy5ah12KTMS85p',
  roomsPhotographed: 'fldgEYCPjjNHIJwRT',
  photos: 'fldySYt7rne1odBpl',
  estimateLow: 'fldMmgllCqDG3SGPn',
  estimateHigh: 'fldSKR5isTfHmgsaC',
  sessionId: 'fldglYPMMCh35TA1I',
  notes: 'fldHdHOypmt319ifV',
};

// Maps the app's internal bedroom count (1-4, where 4 means "4+") to the
// exact option label used in the Airtable "Bedroom Count" single-select.
function bedroomLabel(count) {
  return count >= 4 ? '4+' : String(count);
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

  const {
    sessionId,
    fullName,
    mobile,
    address,
    contactPreference, // "text" | "call" | "email"
    email,
    bedroomCount,      // 1-4
    featuresSelected,  // ["pool", "garage", ...]
    photos,            // [{ room: "kitchen", url: "https://res.cloudinary.com/..." }, ...]
    estimateLow,
    estimateHigh,
  } = payload;

  if (!fullName || !mobile) {
    return { statusCode: 400, body: 'Missing required fields: fullName, mobile' };
  }

  const contactPrefLabel = contactPreference
    ? contactPreference.charAt(0).toUpperCase() + contactPreference.slice(1)
    : undefined;

  const record = {
    fields: {
      [FIELDS.fullName]: fullName,
      [FIELDS.status]: 'Submitted',
      [FIELDS.mobile]: mobile,
      [FIELDS.address]: address || '',
      [FIELDS.contactPreference]: contactPrefLabel,
      [FIELDS.email]: email || undefined,
      [FIELDS.bedroomCount]: bedroomLabel(bedroomCount || 3),
      [FIELDS.featuresSelected]: featuresSelected || [],
      [FIELDS.roomsPhotographed]: Array.isArray(photos) ? photos.length : 0,
      [FIELDS.photos]: Array.isArray(photos)
        ? photos.map((p) => ({ url: p.url }))
        : [],
      [FIELDS.estimateLow]: estimateLow,
      [FIELDS.estimateHigh]: estimateHigh,
      [FIELDS.sessionId]: sessionId || '',
    },
  };

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LEADS_TABLE_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: [record], typecast: true }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error('Airtable error:', res.status, errText);
      return { statusCode: 502, body: 'Failed to save lead' };
    }

    const data = await res.json();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, recordId: data.records[0].id }),
    };
  } catch (err) {
    console.error('submit-lead error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
