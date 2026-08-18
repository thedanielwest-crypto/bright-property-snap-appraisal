// netlify/functions/submit-lead.js
//
// Handles both stages of the Bright Property "Snap Appraisal" flow:
//   1. COLD LEAD — fired the moment someone enters their address on the
//      Front of House step. Creates a new Airtable record with just the
//      address, and returns its recordId to the browser.
//   2. HOT LEAD — fired when someone completes the final "Appraise It" form.
//      If a recordId was passed (the cold lead created earlier in the same
//      session), this UPDATES that same record with full contact details
//      instead of creating a duplicate.
//
// Lead type (Cold Lead / Hot Lead) is stored as the first line of the Notes
// field rather than a dedicated field, since this connector's tools couldn't
// add a new field or new select options at the time this was built — see
// ASSUMPTIONS.md if present, or just add a proper "Lead Type" field in the
// Airtable UI and swap FIELDS.leadType below to point at it directly.
//
// Requires one environment variable, set in Netlify's dashboard:
//   AIRTABLE_API_KEY = a Personal Access Token scoped to this base with
//                       data.records:write access
//
// Base: Snap Appraisals (appiGi6bBUSFYDLha)
// Table: Leads (tblmj5PyEAfZwPHOP)

const BASE_ID = 'appiGi6bBUSFYDLha';
const LEADS_TABLE_ID = 'tblmj5PyEAfZwPHOP';

const FIELDS = {
  fullName: 'fld1xN2C56LeLJdUL',
  status: 'fldDr9YPPXNjt2Ozk',
  mobile: 'fldED0xkBJWkWRKY1',
  address: 'fldwjLEJSFxkBvNsc',
  email: 'fld4VMmFd4hqVlhOc',
  featuresSelected: 'fldfy5ah12KTMS85p',
  roomsPhotographed: 'fldgEYCPjjNHIJwRT',
  photos: 'fldySYt7rne1odBpl',
  sessionId: 'fldglYPMMCh35TA1I',
  notes: 'fldHdHOypmt319ifV',
};

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
    recordId,       // present on the Hot Lead call if a Cold Lead record already exists
    leadType,        // 'Cold Lead' | 'Hot Lead'
    fullName,
    email,
    mobile,
    address,
    featuresSelected,
    photos,
  } = payload;

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
      return { statusCode: 502, body: 'Failed to save lead' };
    }

    const data = await res.json();
    const savedId = isUpdate ? recordId : data.records[0].id;
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, recordId: savedId }),
    };
  } catch (err) {
    console.error('submit-lead error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
