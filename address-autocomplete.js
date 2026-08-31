// netlify/functions/address-autocomplete.js
//
// Proxies to Google's Places API (New) so the API key never reaches the
// browser. Two modes, both used together to form one "session":
//
//   ?mode=search&input=123 Main&sessionToken=<uuid>
//     -> Autocomplete (New) — returns suggestions as you type.
//     Free when paired with a details call in the same session (below).
//
//   ?mode=details&placeId=<id>&sessionToken=<uuid>
//     -> Place Details (New) — called once, when the user picks a
//     suggestion. Requests the smallest possible field set (just the
//     formatted address) to stay on Google's cheapest billing tier, and
//     terminates the session.
//
// Requires GOOGLE_PLACES_API_KEY (server-side env var only — never sent
// to the browser).

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { statusCode: 500, body: 'Address lookup not configured yet (missing GOOGLE_PLACES_API_KEY)' };
  }

  const params = event.queryStringParameters || {};
  const mode = params.mode;
  const sessionToken = params.sessionToken || '';

  try {
    if (mode === 'search') {
      const input = (params.input || '').trim();
      if (input.length < 3) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, suggestions: [] }) };
      }

      const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        },
        body: JSON.stringify({
          input,
          sessionToken,
          includedRegionCodes: ['au'],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error('Places Autocomplete error:', res.status, errText);
        return { statusCode: 502, body: 'Address lookup failed' };
      }

      const data = await res.json();
      const suggestions = (data.suggestions || [])
        .filter((s) => s.placePrediction)
        .map((s) => ({
          placeId: s.placePrediction.placeId,
          text: s.placePrediction.text.text,
        }));

      return { statusCode: 200, body: JSON.stringify({ ok: true, suggestions }) };
    }

    if (mode === 'details') {
      const placeId = params.placeId;
      if (!placeId) {
        return { statusCode: 400, body: 'placeId is required' };
      }

      const res = await fetch(
        `https://places.googleapis.com/v1/places/${placeId}?sessionToken=${encodeURIComponent(sessionToken)}`,
        {
          headers: {
            'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
            // Smallest field mask that gives us what we need — keeps this
            // on Google's cheapest per-call tier.
            'X-Goog-FieldMask': 'formattedAddress',
          },
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        console.error('Places Details error:', res.status, errText);
        return { statusCode: 502, body: 'Address lookup failed' };
      }

      const data = await res.json();
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, formattedAddress: data.formattedAddress || '' }),
      };
    }

    return { statusCode: 400, body: 'mode must be "search" or "details"' };
  } catch (err) {
    console.error('address-autocomplete error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};
