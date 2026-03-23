/**
 * api/validate.js
 * POST /api/validate
 * Validates a brief payload without making any Meta API calls.
 * Call this before showing the push confirmation to the user.
 */

import { validateBrief } from '../lib/validate.js';

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  if (!payload) {
    return res.status(400).json({ error: 'Request body is empty.' });
  }

  const result = validateBrief(payload);

  return res.status(200).json(result);
}
