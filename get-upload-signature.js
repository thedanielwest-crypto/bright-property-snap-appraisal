// netlify/functions/get-upload-signature.js
//
// Returns a short-lived signed payload that lets the browser upload a photo
// directly to Cloudinary, scoped to this session's folder, without ever
// exposing your Cloudinary API secret to the client.
//
// Requires three environment variables, set in Netlify's dashboard under
// Site settings → Environment variables:
//
//   CLOUDINARY_CLOUD_NAME = your Cloudinary cloud name
//   CLOUDINARY_API_KEY    = your Cloudinary API key
//   CLOUDINARY_API_SECRET = your Cloudinary API secret (never exposed to the browser)
//
// Get all three free at cloudinary.com after creating an account.

const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sessionId =
    (event.queryStringParameters && event.queryStringParameters.sessionId) ||
    'unknown-session';

  // Basic sanitisation so a stray sessionId can't escape the folder scope.
  const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  const folder = `appraisals/${safeSessionId}`;
  const timestamp = Math.round(Date.now() / 1000);

  // Cloudinary requires signing every param you'll send with the upload,
  // sorted alphabetically, excluding file/api_key/signature/resource_type.
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash('sha1')
    .update(paramsToSign + process.env.CLOUDINARY_API_SECRET)
    .digest('hex');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp,
      folder,
      signature,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    }),
  };
};
