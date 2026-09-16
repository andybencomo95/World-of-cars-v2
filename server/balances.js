// Persistent virtual-coin balances with a per-nick faucet (TM-001 fixed).
// Pure helpers (no sockets bound) so tests can require this module safely.
// Faucet rule: every NEW nick starts with INITIAL_BALANCE (1000).
// Same IP may claim for many nicks (LAN / NAT safe). Anti-farm is handled
// by per-IP rate limits in the WS layer, not by blocking the faucet.
// A stored zero balance stays zero — never a phantom refill.
'use strict';
const fs = require('fs').promises;
const path = require('path');

const INITIAL_BALANCE = 1000; // starting grant for first nick per IP per day
const DATA_DIR = path.join(__dirname, 'data');
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
const FAUCETS_FILE = path.join(DATA_DIR, 'faucets.json');

function todayKey(d) {
  const t = d instanceof Date ? d : new Date();
  return t.toISOString().slice(0, 10); // UTC day
}

function balanceKey(nick, ip) {
  return `${nick}#${ip}`;
}

function storedValue(balances, key) {
  if (!balances || typeof balances !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(balances, key)) return undefined;
  const v = balances[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Returns the stored balance, or 0 for unknown nicks (minting happens only
// via claimFaucet — reading never creates money).
function getBalance(balances, nick, ip) {
  const v = storedValue(balances, balanceKey(nick, ip));
  return v === undefined ? 0 : v;
}

// Grants INITIAL_BALANCE to a nick that has never held coins.
// Every unknown nick is funded (LAN-safe). Mutates `balances` and `faucets`.
// Returns true if the faucet paid out (caller must persist both stores).
function claimFaucet(balances, faucets, nick, ip, today) {
  const key = balanceKey(nick, ip);
  if (storedValue(balances, key) !== undefined) return false; // known nick: no grant
  const day = today || todayKey();
  balances[key] = INITIAL_BALANCE;
  if (faucets && typeof faucets === 'object') faucets[ip] = day;
  return true;
}

// Adds amount (negative to subtract). Unknown nicks start from 0.
// Keeps the historical floor at 0 (never negative balances).
function updateBalance(balances, nick, ip, amount) {
  const key = balanceKey(nick, ip);
  const cur = storedValue(balances, key);
  balances[key] = (cur === undefined ? 0 : cur) + amount;
  if (balances[key] < 0) balances[key] = 0;
  return balances[key];
}

async function loadJson(file) {
  try {
    const data = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError('expected JSON object');
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    if (err instanceof SyntaxError) {
      try { await fs.rename(file, file + '.corrupt'); } catch (e) {}
      console.error('Corrupt store file, starting fresh:', file, err.message);
      return {};
    }
    throw err;
  }
}

async function loadBalances() {
  return loadJson(BALANCES_FILE);
}

async function loadFaucets() {
  return loadJson(FAUCETS_FILE);
}

// Serialized writes (tmp + atomic rename) shared by both stores.
let _saveChain = Promise.resolve();
function saveJson(file, obj) {
  const data = JSON.stringify(obj, null, 2);
  _saveChain = _saveChain.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  }).catch((err) => console.error('Failed to save store:', file, err));
  return _saveChain;
}

function saveBalances(balances) {
  return saveJson(BALANCES_FILE, balances);
}

function saveFaucets(faucets) {
  return saveJson(FAUCETS_FILE, faucets);
}

module.exports = {
  INITIAL_BALANCE,
  BALANCES_FILE,
  FAUCETS_FILE,
  todayKey,
  balanceKey,
  getBalance,
  claimFaucet,
  updateBalance,
  loadBalances,
  loadFaucets,
  saveBalances,
  saveFaucets
};
