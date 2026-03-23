/**
 * api/push.js
 * POST /api/push
 * Executes the full Meta campaign push and streams NDJSON progress events.
 * maxDuration: 120s (set in vercel.json — pushes of 50 ads take ~60–90s)
 */

import { validateBrief }                           from '../lib/validate.js';
import { createStream }                            from '../lib/stream.js';
import { savePushRecord, incrementRateLimit }      from '../lib/kv.js';
import {
  createCampaign,
  uploadAssetByUrl,
  uploadVideoByUrl,
  createAdCreative,
  createAdSet,
  createAd,
} from '../lib/meta.js';

const RATE_LIMIT_MAX = 10; // pushes per hour per IP
const ADSET_BATCH_SIZE = 5; // create ad sets in batches to respect Meta rate limits
const BATCH_DELAY_MS = 200;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ── Rate limiting ────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const count = await incrementRateLimit(ip);
  if (count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX} pushes per hour.`,
      retryAfter: '1 hour',
    });
  }

  // ── Parse body ───────────────────────────────────────────────────
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  // ── Validate ─────────────────────────────────────────────────────
  const validation = validateBrief(payload);
  if (!validation.valid) {
    return res.status(422).json({
      error: 'Brief validation failed.',
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }

  // ── Open stream ──────────────────────────────────────────────────
  const stream = createStream(res);
  const approvedAds = payload.ads.filter(a => a.status === 'approved');

  stream.write('start', {
    total: approvedAds.length,
    campaignName: payload.campaignName,
    warnings: validation.warnings,
  });

  // Track results for history record
  const result = {
    campaignId: null,
    adSetIds: [],
    adIds: [],
    errors: [],
    warnings: validation.warnings,
  };

  try {
    // ── Step 1: Create campaign ────────────────────────────────────
    stream.write('progress', { message: 'Creating campaign…', step: 1, totalSteps: 4 });

    const campaign = await createCampaign({
      name: payload.campaignName,
      objective: payload.objective,
      startTime: payload.startDate ? `${payload.startDate}T00:00:00+0000` : undefined,
    });

    result.campaignId = campaign.id;
    stream.write('campaign', { id: campaign.id, name: payload.campaignName });

    // ── Step 2: Upload creative assets (deduplicated by URL) ───────
    stream.write('progress', { message: 'Uploading creative assets…', step: 2, totalSteps: 4 });

    const uniqueAssets = deduplicateAssets(approvedAds);
    const assetHashMap = {}; // url → { hash/id, type }

    for (const asset of uniqueAssets) {
      try {
        const isVideo = isVideoUrl(asset.url);
        if (isVideo) {
          const uploaded = await uploadVideoByUrl({ name: asset.name, url: asset.url });
          assetHashMap[asset.url] = { id: uploaded.id, type: 'video' };
          stream.write('asset', { name: asset.name, videoId: uploaded.id, type: 'video' });
        } else {
          const uploaded = await uploadAssetByUrl({ name: asset.name, url: asset.url });
          assetHashMap[asset.url] = { hash: uploaded.hash, type: 'image' };
          stream.write('asset', { name: asset.name, hash: uploaded.hash, type: 'image' });
        }
      } catch (err) {
        // Asset upload failure is recoverable — the ad will be skipped
        const msg = `Asset "${asset.name}" upload failed: ${err.message}`;
        result.errors.push(msg);
        stream.write('error', { item: asset.name, message: msg, recoverable: true });
      }
    }

    // ── Step 3: Create ad sets (batched) ───────────────────────────
    stream.write('progress', { message: `Creating ${approvedAds.length} ad sets…`, step: 3, totalSteps: 4 });

    const adSetIdMap = {}; // adSetName → adSetId
    const batches = chunk(approvedAds, ADSET_BATCH_SIZE);

    for (const batch of batches) {
      await Promise.all(batch.map(async (ad) => {
        // Skip if this ad set name was already created (same adSetName = same ad set)
        if (adSetIdMap[ad.adSetName]) return;

        try {
          const adSet = await createAdSet({
            campaignId: campaign.id,
            name: ad.adSetName,
            market: ad.market,
            audience: ad.audience,
            placement: ad.placement,
            objective: payload.objective,
            startTime: payload.startDate ? `${payload.startDate}T00:00:00+0000` : undefined,
          });

          adSetIdMap[ad.adSetName] = adSet.id;
          result.adSetIds.push(adSet.id);
          stream.write('adset', { id: adSet.id, name: ad.adSetName });
        } catch (err) {
          const msg = `Ad set "${ad.adSetName}" failed: ${err.message}`;
          result.errors.push(msg);
          stream.write('error', { item: ad.adSetName, message: msg, recoverable: true });
        }
      }));

      // Delay between batches to respect Meta rate limits
      if (batches.indexOf(batch) < batches.length - 1) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // ── Step 4: Create ads ─────────────────────────────────────────
    stream.write('progress', { message: 'Creating ads…', step: 4, totalSteps: 4 });

    for (const ad of approvedAds) {
      const adSetId = adSetIdMap[ad.adSetName];
      if (!adSetId) {
        // Ad set creation failed for this one — skip ad
        stream.write('error', {
          item: ad.adName,
          message: `Skipped — ad set "${ad.adSetName}" was not created successfully.`,
          recoverable: true,
        });
        continue;
      }

      const assetData = assetHashMap[ad.creativeUrl];
      if (!assetData) {
        stream.write('error', {
          item: ad.adName,
          message: `Skipped — asset "${ad.creativeName}" was not uploaded successfully.`,
          recoverable: true,
        });
        continue;
      }

      try {
        // Create AdCreative
        const creative = await createAdCreative({
          name: `${ad.adName}_creative`,
          imageHash: assetData.type === 'image' ? assetData.hash : undefined,
          videoId: assetData.type === 'video' ? assetData.id : undefined,
          headline: ad.headline,
          body: ad.body,
          cta: ad.cta,
          destinationUrl: payload.destinationUrl,
          pageId: payload.pageId, // Optional — from settings
        });

        // Create Ad
        const created = await createAd({
          adSetId,
          name: ad.adName,
          creativeId: creative.id,
        });

        result.adIds.push(created.id);
        stream.write('ad', {
          id: created.id,
          name: ad.adName,
          adSetId,
          funnel: ad.funnel,
          market: ad.market,
        });
      } catch (err) {
        const msg = `Ad "${ad.adName}" failed: ${err.message}`;
        result.errors.push(msg);
        stream.write('error', { item: ad.adName, message: msg, recoverable: true });
      }

      // Small delay between ads to be polite to Meta's API
      await sleep(50);
    }

  } catch (err) {
    // Fatal error (e.g. campaign creation failed) — abort and report
    stream.write('fatal', {
      message: `Push aborted: ${err.message}`,
      hint: err.metaCode === 190
        ? 'Access token is invalid or expired. Generate a new System User token in Business Manager.'
        : err.metaCode === 100
        ? 'Invalid parameter. Check your Ad Account ID and Meta API version.'
        : 'Check your Meta API credentials in Settings.',
    });
    stream.write('done', {
      campaignId: result.campaignId,
      total: 0,
      succeeded: 0,
      errors: result.errors.length + 1,
      aborted: true,
    });
    stream.end();
    return;
  }

  // ── Save history record ──────────────────────────────────────────
  const historyRecord = {
    id: `push_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    date: new Date().toISOString(),
    campaignId: result.campaignId,
    campaignName: payload.campaignName,
    total: approvedAds.length,
    succeeded: result.adIds.length,
    errors: result.errors.length,
    markets: [...new Set(approvedAds.map(a => a.market))],
    funnels: [...new Set(approvedAds.map(a => a.funnel))],
    warnings: result.warnings.length,
  };
  await savePushRecord(historyRecord);

  // ── Final done event ─────────────────────────────────────────────
  stream.write('done', {
    campaignId: result.campaignId,
    historyId: historyRecord.id,
    total: approvedAds.length,
    succeeded: result.adIds.length,
    errors: result.errors.length,
    aborted: false,
    note: 'All ads created in PAUSED state. Set budgets and activate in Meta Ads Manager.',
  });

  stream.end();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Deduplicate assets by URL across all ads */
function deduplicateAssets(ads) {
  const seen = new Set();
  const assets = [];
  for (const ad of ads) {
    if (ad.creativeUrl && !seen.has(ad.creativeUrl)) {
      seen.add(ad.creativeUrl);
      assets.push({ name: ad.creativeName, url: ad.creativeUrl });
    }
  }
  return assets;
}

/** Check if a URL is likely a video file */
function isVideoUrl(url) {
  return /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(url);
}

/** Split array into chunks of size n */
function chunk(arr, n) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += n) chunks.push(arr.slice(i, i + n));
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
