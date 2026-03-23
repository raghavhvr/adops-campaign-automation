/**
 * api/status.js
 * GET /api/status?campaignId=120xxxxx
 * Returns live status of a campaign from Meta.
 */

import { getCampaignStatus } from '../lib/meta.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const { campaignId } = req.query;

  if (!campaignId?.trim()) {
    return res.status(400).json({ error: 'campaignId query parameter is required.' });
  }

  // Basic format check — Meta campaign IDs are numeric strings
  if (!/^\d+$/.test(campaignId)) {
    return res.status(400).json({ error: 'Invalid campaignId format. Must be a numeric string.' });
  }

  try {
    const status = await getCampaignStatus(campaignId);
    return res.status(200).json(status);
  } catch (err) {
    return res.status(502).json({
      error: 'Failed to fetch campaign status from Meta.',
      detail: err.message,
    });
  }
}
