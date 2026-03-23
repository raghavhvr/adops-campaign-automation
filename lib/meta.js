/**
 * lib/meta.js
 * Single source of truth for all Meta Marketing API calls.
 * Only this file reads META_* environment variables.
 */

// ─── Config ────────────────────────────────────────────────────────────────

function getConfig() {
  const token   = process.env.META_ACCESS_TOKEN;
  const account = process.env.META_AD_ACCOUNT_ID;
  const version = process.env.META_API_VERSION || 'v20.0';
  const pixel   = process.env.META_PIXEL_ID;

  if (!token)   throw new Error('META_ACCESS_TOKEN is not set. Add it to your Vercel environment variables.');
  if (!account) throw new Error('META_AD_ACCOUNT_ID is not set. Add it to your Vercel environment variables.');

  // Warn if token looks like a short-lived user token (they start with EAA and are ~200 chars)
  // System User tokens are longer. This is a heuristic only — not a hard block.
  if (token.length < 100) {
    console.warn('[meta] Warning: Access token is unusually short. Ensure you are using a System User token, not a short-lived user token.');
  }

  return { token, account, version, pixel };
}

function baseUrl() {
  const { version, account } = getConfig();
  return `https://graph.facebook.com/${version}/${account}`;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

/**
 * Authenticated POST to Meta Graph API.
 * @returns {Promise<object>} Parsed response data
 */
async function metaPost(path, body) {
  const { token } = getConfig();
  const url = path.startsWith('http') ? path : `${baseUrl()}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  // Meta often returns 200 with an error body — always check
  if (data.error) {
    const msg = data.error.error_user_msg || data.error.message || 'Unknown Meta API error';
    const err = new Error(msg);
    err.metaCode = data.error.code;
    err.metaSubcode = data.error.error_subcode;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`Meta API HTTP ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Authenticated GET to Meta Graph API.
 * @returns {Promise<object>} Parsed response data
 */
async function metaGet(path, params = {}) {
  const { token } = getConfig();
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const url = path.startsWith('http')
    ? `${path}?${qs}`
    : `${baseUrl()}${path}?${qs}`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await res.json();

  if (data.error) {
    const msg = data.error.error_user_msg || data.error.message || 'Unknown Meta API error';
    throw new Error(msg);
  }

  return data;
}

// ─── Campaign ──────────────────────────────────────────────────────────────

/**
 * Creates a Meta campaign object.
 * @returns {Promise<{id: string}>}
 */
export async function createCampaign({ name, objective, startTime }) {
  const data = await metaPost('/campaigns', {
    name,
    objective,
    status: 'PAUSED', // Always start paused — AdOps activates manually in Ads Manager
    special_ad_categories: [],
    ...(startTime ? { start_time: startTime } : {}),
  });
  return { id: data.id };
}

// ─── Creative assets ───────────────────────────────────────────────────────

/**
 * Uploads an image asset to Meta by URL and returns its hash.
 * Meta uses hashes as references when creating ads.
 * @returns {Promise<{hash: string, name: string}>}
 */
export async function uploadAssetByUrl({ name, url }) {
  // Meta's adimages endpoint accepts a URL to copy from
  const data = await metaPost('/adimages', {
    filename: name,
    url,
  });

  // Response shape: { images: { [filename]: { hash, url, ... } } }
  const images = data.images || {};
  const key = Object.keys(images)[0];
  if (!key) throw new Error(`Asset upload failed for "${name}" — no hash returned`);

  return { hash: images[key].hash, name };
}

/**
 * Creates a video creative from a URL (for video ad assets).
 * @returns {Promise<{id: string, name: string}>}
 */
export async function uploadVideoByUrl({ name, url }) {
  const data = await metaPost('/advideos', {
    name,
    file_url: url,
  });
  return { id: data.id, name };
}

/**
 * Creates an AdCreative object that wraps a previously uploaded asset.
 * @returns {Promise<{id: string}>}
 */
export async function createAdCreative({ name, imageHash, videoId, headline, body, cta, destinationUrl, pageId }) {
  const { pixel } = getConfig();

  const linkData = {
    message: body,
    link: destinationUrl,
    name: headline,
    call_to_action: {
      type: ctaToMetaType(cta),
      value: { link: destinationUrl },
    },
  };

  // Use image or video depending on what was uploaded
  if (imageHash) linkData.image_hash = imageHash;

  const objectStorySpec = {
    link_data: linkData,
    ...(pageId ? { page_id: pageId } : {}),
  };

  const data = await metaPost('/adcreatives', {
    name,
    object_story_spec: objectStorySpec,
    ...(pixel ? { pixel_id: pixel } : {}),
  });

  return { id: data.id };
}

// ─── Ad Set ────────────────────────────────────────────────────────────────

/**
 * Builds Meta targeting spec from our market + audience data.
 * Mapping is kept intentionally simple — AdOps can refine in Ads Manager.
 */
function buildTargeting(market, audience, placement) {
  const geoMap = {
    UAE: 'AE', US: 'US', UK: 'GB', EU: ['DE', 'FR', 'ES', 'IT', 'NL'],
    IN: 'IN',
  };

  const geo = geoMap[market];
  const countries = Array.isArray(geo) ? geo : [geo || market];

  return {
    geo_locations: { countries },
    // Placement: let Meta optimise unless "Feed only" or "Stories + Reels"
    ...(placement?.includes('Feed only') ? {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed'],
      instagram_positions: ['stream'],
    } : placement?.includes('Stories') ? {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['story'],
      instagram_positions: ['story', 'reels'],
    } : {}),
    // Age targeting based on audience hint — default to broad
    age_min: audienceToAgeMin(audience),
    age_max: audienceToAgeMax(audience),
  };
}

function audienceToAgeMin(audience) {
  const a = audience.toLowerCase();
  if (a.includes('18') || a.includes('gen z')) return 18;
  if (a.includes('25')) return 25;
  if (a.includes('35')) return 35;
  if (a.includes('45')) return 45;
  return 18; // default broad
}

function audienceToAgeMax(audience) {
  const a = audience.toLowerCase();
  if (a.includes('24')) return 24;
  if (a.includes('34')) return 34;
  if (a.includes('44')) return 44;
  if (a.includes('54')) return 54;
  return 65; // default broad
}

/**
 * Creates a Meta ad set within a campaign.
 * Budget is intentionally not set here — AdOps sets it in Ads Manager.
 * @returns {Promise<{id: string}>}
 */
export async function createAdSet({ campaignId, name, market, audience, placement, objective, startTime }) {
  const targeting = buildTargeting(market, audience, placement);

  const data = await metaPost('/adsets', {
    name,
    campaign_id: campaignId,
    status: 'PAUSED',
    billing_event: 'IMPRESSIONS',
    optimization_goal: objectiveToOptimisationGoal(objective),
    targeting,
    // Minimum daily budget of $1 as placeholder — AdOps sets real budget in Ads Manager
    daily_budget: 100, // in cents = $1.00
    ...(startTime ? { start_time: startTime } : {}),
  });

  return { id: data.id };
}

// ─── Ad ────────────────────────────────────────────────────────────────────

/**
 * Creates a Meta ad linking an ad set to a creative.
 * @returns {Promise<{id: string}>}
 */
export async function createAd({ adSetId, name, creativeId }) {
  const data = await metaPost('/ads', {
    name,
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status: 'PAUSED',
  });

  return { id: data.id };
}

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * Fetches live status of a campaign from Meta.
 * @returns {Promise<{status, effectiveStatus, adSetsCount, adsCount}>}
 */
export async function getCampaignStatus(campaignId) {
  const { version } = getConfig();
  const { token } = getConfig();

  const data = await metaGet(
    `https://graph.facebook.com/${version}/${campaignId}`,
    { fields: 'status,effective_status,name' }
  );

  // Get ad set count
  const adSets = await metaGet(
    `https://graph.facebook.com/${version}/${campaignId}/adsets`,
    { fields: 'id,status', limit: 100 }
  );

  return {
    campaignId,
    name: data.name,
    status: data.status,
    effectiveStatus: data.effective_status,
    adSetsCount: adSets.data?.length || 0,
  };
}

// ─── Mapping helpers ───────────────────────────────────────────────────────

function ctaToMetaType(cta) {
  const map = {
    'Learn More': 'LEARN_MORE',
    'See Options': 'LEARN_MORE',
    'Start Now': 'SIGN_UP',
    'Shop Now': 'SHOP_NOW',
    'Sign Up': 'SIGN_UP',
    'Contact Us': 'CONTACT_US',
    'Download': 'DOWNLOAD',
  };
  return map[cta] || 'LEARN_MORE';
}

function objectiveToOptimisationGoal(objective) {
  const map = {
    'OUTCOME_AWARENESS': 'REACH',
    'OUTCOME_TRAFFIC': 'LINK_CLICKS',
    'OUTCOME_LEADS': 'LEAD_GENERATION',
    'OUTCOME_SALES': 'OFFSITE_CONVERSIONS',
    'OUTCOME_ENGAGEMENT': 'POST_ENGAGEMENT',
  };
  return map[objective] || 'LINK_CLICKS';
}
