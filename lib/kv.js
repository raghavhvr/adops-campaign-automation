/**
 * lib/kv.js
 * Vercel KV wrapper for persisting push history.
 * Push history metadata only — never stores ad copy or audience data.
 */

import { kv } from '@vercel/kv';

const HISTORY_KEY = 'push:history';
const HISTORY_TTL = 60 * 60 * 24 * 90; // 90 days in seconds
const MAX_HISTORY = 50; // Cap stored records to avoid unbounded growth

/**
 * Saves a push record to KV history.
 * @param {object} record — push metadata
 * @returns {Promise<void>}
 */
export async function savePushRecord(record) {
  try {
    const existing = await kv.get(HISTORY_KEY) || [];
    const updated = [record, ...existing].slice(0, MAX_HISTORY);
    await kv.set(HISTORY_KEY, updated, { ex: HISTORY_TTL });
  } catch (err) {
    // KV failure is non-fatal — log but don't abort the push
    console.warn('[kv] Failed to save push record:', err.message);
  }
}

/**
 * Retrieves push history, newest first.
 * @param {number} limit — max records to return (default 20)
 * @returns {Promise<Array>}
 */
export async function getPushHistory(limit = 20) {
  try {
    const records = await kv.get(HISTORY_KEY) || [];
    return records.slice(0, Math.min(limit, MAX_HISTORY));
  } catch (err) {
    console.warn('[kv] Failed to read push history:', err.message);
    return [];
  }
}

/**
 * Increments a rate-limit counter for a given key (e.g. IP address).
 * Returns the current count after increment.
 * TTL resets the window after 1 hour.
 * @param {string} key
 * @returns {Promise<number>}
 */
export async function incrementRateLimit(key) {
  try {
    const rlKey = `ratelimit:${key}`;
    const count = await kv.incr(rlKey);
    if (count === 1) {
      // First hit in this window — set the 1-hour TTL
      await kv.expire(rlKey, 3600);
    }
    return count;
  } catch {
    // If KV is down, allow the request through rather than blocking all pushes
    return 0;
  }
}
