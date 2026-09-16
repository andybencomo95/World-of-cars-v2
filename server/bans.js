// IP banning system with strikes and persistence
// Stores bans in data/bans.json and strikes in memory

const fs = require('fs').promises;
const path = require('path');

const BANS_FILE = path.join(__dirname, 'data', 'bans.json');
// Default strike threshold for ban
const STRIKE_THRESHOLD = 3;
// Default temporary ban duration in milliseconds (1 hour)
const TEMP_BAN_DURATION = 60 * 60 * 1000;

/**
 * Loads bans from JSON file, removing expired entries
 * @returns {Promise<Array<{ip:string, reason:string, expires:number}>>} array of active bans
 */
// A ban entry is only trusted with the right shape; anything else is
// dropped (self-healing) instead of crashing the caller (TM-009).
function isValidBanEntry(ban) {
  return !!ban && typeof ban === 'object'
    && typeof ban.ip === 'string' && ban.ip.length > 0
    && typeof ban.reason === 'string'
    && typeof ban.expires === 'number' && Number.isFinite(ban.expires);
}

async function loadBans() {
  try {
    const data = await fs.readFile(BANS_FILE, 'utf8');
    const bans = JSON.parse(data);
    if (!Array.isArray(bans)) {
      // Not a ban list at all: quarantine like a corrupt file, fail closed.
      try { await fs.rename(BANS_FILE, BANS_FILE + '.corrupt'); } catch (e) {}
      console.error('Bans file is not an array, quarantined, starting fresh');
      return [];
    }
    const now = Date.now();
    // Filter out expired bans AND malformed entries
    const activeBans = bans.filter(ban => isValidBanEntry(ban) && ban.expires > now);
    if (activeBans.length !== bans.length) {
      // Save back the cleaned list to keep file clean
      await saveBans(activeBans);
    }
    return activeBans;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File doesn't exist yet, return empty array
      return [];
    }
    throw err;
  }
}

/**
 * Saves bans array to JSON file
 * @param {Array<{ip:string, reason:string, expires:number}>} bans
 * @returns {Promise<void>}
 */
async function saveBans(bans) {
  const data = JSON.stringify(bans, null, 2);
  // Ensure directory exists
  const dir = path.dirname(BANS_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(BANS_FILE, data, 'utf8');
}

/**
 * Adds a ban for an IP
 * @param {string} ip
 * @param {string} reason
 * @param {number} ttlMillis - ban duration in milliseconds
 * @returns {Promise<void>}
 */
async function ban(ip, reason, ttlMillis) {
  if (!ip || !reason || typeof ttlMillis !== 'number' || ttlMillis <= 0) {
    throw new Error('Invalid ban parameters');
  }
  const expires = Date.now() + ttlMillis;
  const bans = await loadBans();
  // Remove any existing ban for this IP (to avoid duplicates)
  const filtered = bans.filter(b => b.ip !== ip);
  filtered.push({ ip, reason, expires });
  await saveBans(filtered);
}

/**
 * Checks if an IP is currently banned
 * @param {string} ip
 * @returns {Promise<boolean>} true if banned
 */
async function isBanned(ip) {
  if (!ip) return false;
  const bans = await loadBans();
  return bans.some(ban => ban.ip === ip && ban.expires > Date.now());
}

/**
 * Gets the strike count for an IP (in memory)
 * We'll use a closure to hold the strikes map.
 * Note: strikes are not persisted, only in memory for the current server process.
 */
let strikesMap = new Map();

/**
 * Increments strike count for an IP and returns the new count
 * @param {string} ip
 * @returns {number} new strike count
 */
function strike(ip) {
  if (!ip) return 0;
  const current = strikesMap.get(ip) || 0;
  const newCount = current + 1;
  strikesMap.set(ip, newCount);
  return newCount;
}

/**
 * Resets strike count for an IP
 * @param {string} ip
 */
function clearStrikes(ip) {
  if (ip) {
    strikesMap.delete(ip);
  }
}

/**
 * Checks if an IP should be banned due to strikes (3 strikes -> temp ban)
 * @param {string} ip
 * @param {string} reason - reason for ban when striking out
 * @returns {Promise<boolean>} true if a ban was applied
 */
async function checkStrikesAndBan(ip, reason) {
  if (!ip || !reason) return false;
  const count = strike(ip);
  if (count >= STRIKE_THRESHOLD) {
    // Apply temporary ban
    await ban(ip, reason, TEMP_BAN_DURATION);
    // Reset strikes after banning
    clearStrikes(ip);
    return true;
  }
  return false;
}

module.exports = {
  loadBans,
  isValidBanEntry,
  saveBans,
  ban,
  isBanned,
  strike,
  clearStrikes,
  checkStrikesAndBan
};