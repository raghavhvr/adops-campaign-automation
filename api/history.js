/**
 * api/history.js
 * GET /api/history?limit=20
 * Returns push history from Vercel KV, newest first.
 */

import { getPushHistory } from '../lib/kv.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);

  if (isNaN(limit) || limit < 1) {
    return res.status(400).json({ error: 'limit must be a number between 1 and 50.' });
  }

  const records = await getPushHistory(limit);

  return res.status(200).json({ records, count: records.length });
}
