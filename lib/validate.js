/**
 * lib/validate.js
 * Pure validation functions — no I/O, no Meta API calls, fully testable.
 */

const REQUIRED_AD_FIELDS = ['adSetName', 'adName', 'funnel', 'market', 'audience', 'creativeName', 'creativeUrl', 'headline', 'cta'];
const VALID_OBJECTIVES   = ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_ENGAGEMENT'];
const VALID_FUNNELS      = ['Upper', 'Mid', 'Lower'];
const VALID_MARKETS      = ['UAE', 'US', 'UK', 'EU', 'IN'];
const MAX_HEADLINE_CHARS = 40;
const MAX_BODY_CHARS     = 125;
const MAX_ADS_PER_PUSH   = 100;

/**
 * Validates a full brief payload before any Meta API calls are made.
 * @param {object} payload — the POST body from the frontend
 * @returns {{ valid: boolean, warnings: string[], errors: string[] }}
 */
export function validateBrief(payload) {
  const errors   = [];
  const warnings = [];

  // ── Top-level fields ───────────────────────────────────────────
  if (!payload.campaignName?.trim()) {
    errors.push('Campaign name is required.');
  } else if (payload.campaignName.length > 100) {
    warnings.push(`Campaign name is ${payload.campaignName.length} chars — Meta truncates at 100.`);
  }

  if (!payload.objective) {
    errors.push('Campaign objective is required.');
  } else if (!VALID_OBJECTIVES.includes(payload.objective)) {
    errors.push(`Invalid objective "${payload.objective}". Must be one of: ${VALID_OBJECTIVES.join(', ')}.`);
  }

  if (payload.startDate && !isValidDate(payload.startDate)) {
    errors.push(`Invalid start date "${payload.startDate}". Use YYYY-MM-DD format.`);
  }

  if (payload.startDate && new Date(payload.startDate) < new Date()) {
    warnings.push('Start date is in the past — Meta may reject or adjust it.');
  }

  if (!payload.destinationUrl?.trim()) {
    errors.push('Destination URL is required.');
  } else if (!isValidUrl(payload.destinationUrl)) {
    errors.push(`Destination URL "${payload.destinationUrl}" is not a valid URL.`);
  }

  // ── Ads array ──────────────────────────────────────────────────
  if (!Array.isArray(payload.ads) || payload.ads.length === 0) {
    errors.push('No ads provided in the payload.');
    return { valid: errors.length === 0, warnings, errors };
  }

  const approvedAds = payload.ads.filter(a => a.status === 'approved');

  if (approvedAds.length === 0) {
    errors.push('No approved ads to push. Approve at least one ad in the Preview step.');
  }

  if (approvedAds.length > MAX_ADS_PER_PUSH) {
    errors.push(`Too many approved ads (${approvedAds.length}). Maximum per push is ${MAX_ADS_PER_PUSH}.`);
  }

  // ── Per-ad validation ──────────────────────────────────────────
  approvedAds.forEach((ad, i) => {
    const label = `Ad ${i + 1} "${ad.adSetName || ad.id}"`;

    // Required fields
    REQUIRED_AD_FIELDS.forEach(field => {
      if (!ad[field]?.toString().trim()) {
        errors.push(`${label}: missing required field "${field}".`);
      }
    });

    // Funnel
    if (ad.funnel && !VALID_FUNNELS.includes(ad.funnel)) {
      errors.push(`${label}: invalid funnel "${ad.funnel}".`);
    }

    // Market
    if (ad.market && !VALID_MARKETS.includes(ad.market)) {
      warnings.push(`${label}: market "${ad.market}" is not in the standard list — targeting may be broad.`);
    }

    // Headline length
    if (ad.headline && ad.headline.length > MAX_HEADLINE_CHARS) {
      errors.push(`${label}: headline is ${ad.headline.length} chars — max is ${MAX_HEADLINE_CHARS}. Meta will reject this.`);
    } else if (ad.headline && ad.headline.length > 35) {
      warnings.push(`${label}: headline is ${ad.headline.length}/${MAX_HEADLINE_CHARS} chars — close to the limit.`);
    }

    // Body length
    if (ad.body && ad.body.length > MAX_BODY_CHARS) {
      warnings.push(`${label}: primary text is ${ad.body.length} chars — Meta recommends under ${MAX_BODY_CHARS} for best delivery.`);
    }

    // Creative URL
    if (ad.creativeUrl && !isValidUrl(ad.creativeUrl)) {
      errors.push(`${label}: creative URL "${ad.creativeUrl}" is not a valid URL.`);
    }

    // Ad set name characters (Meta rejects some special chars)
    if (ad.adSetName && /[<>"']/.test(ad.adSetName)) {
      errors.push(`${label}: ad set name contains invalid characters (< > " '). Remove them.`);
    }
  });

  // ── Duplicate ad set names ─────────────────────────────────────
  const adSetNames = approvedAds.map(a => a.adSetName);
  const dupes = adSetNames.filter((name, i) => adSetNames.indexOf(name) !== i);
  if (dupes.length > 0) {
    errors.push(`Duplicate ad set names detected: ${[...new Set(dupes)].join(', ')}. Each must be unique.`);
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}
