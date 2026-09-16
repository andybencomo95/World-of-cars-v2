// Fair play core for World of Cars online racing.
// Pure logic (no WebSocket, no fs at import). The WS layer (server/index.js)
// calls recordStrike()/shouldKick()/shouldBan() and server/bans.ban().
// Strike ledger is in-memory with a 10-minute sliding decay window.

const fs = require('fs');
const path = require('path');

const STRIKE_WEIGHTS = {
  FLOOD: 1, // message flooding / rate abuse
  BAD_INPUT: 1, // out-of-range or malformed inputs
  SPOOF: 2, // schema/JSON/protocol spoofing
  PHYS: 2, // impossible physics / teleport
  ABUSE: 2 // oversized payloads, connection abuse
};

const KICK_AT = 3;
const BAN_AT = 5;
const DECAY_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BYTES = 4096;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

// ip -> { count:number, firstTs:number }
const ledger = new Map();
// input timestamps per key for sliding-window rate checks
const inputWindows = new Map();

let logFile = path.join(__dirname, 'data', 'fairplay.log');

function setLogFile(p) {
  if (typeof p === 'string' && p) logFile = p;
}

function nowMs() {
  return Date.now();
}

function weightOf(code) {
  return STRIKE_WEIGHTS[code] || 1;
}

/**
 * Records a weighted strike for an IP. Never throws.
 * @param {string} ip
 * @param {string} code one of FLOOD|BAD_INPUT|SPOOF|PHYS|ABUSE
 * @param {number} [at] timestamp override (tests)
 * @returns {number} new total
 */
function recordStrike(ip, code, at) {
  try {
    if (!ip || typeof ip !== 'string') return 0;
    const t = typeof at === 'number' ? at : nowMs();
    let rec = ledger.get(ip);
    if (!rec || t - rec.firstTs > DECAY_MS) rec = { count: 0, firstTs: t };
    rec.count += weightOf(code);
    ledger.set(ip, rec);
    return rec.count;
  } catch (e) {
    return 0;
  }
}

function getStrikes(ip, at) {
  try {
    const rec = ledger.get(ip);
    if (!rec) return 0;
    const t = typeof at === 'number' ? at : nowMs();
    if (t - rec.firstTs > DECAY_MS) {
      ledger.delete(ip);
      return 0;
    }
    return rec.count;
  } catch (e) {
    return 0;
  }
}

function clearStrikes(ip) {
  try {
    ledger.delete(ip);
  } catch (e) {}
}

function shouldKick(ip, at) {
  const c = getStrikes(ip, at);
  return c >= KICK_AT && c < BAN_AT;
}

function shouldBan(ip, at) {
  return getStrikes(ip, at) >= BAN_AT;
}

/**
 * Pre-parse envelope guard: rejects oversized raw messages. Never throws.
 * @param {string|Buffer} raw
 * @param {number} [maxBytes]
 * @returns {{ok:boolean, code?:string}}
 */
/**
 * Origin allowlist check for WS handshake (CSWSH mitigation).
 * No Origin header (non-browser clients) is allowed. Pure, never throws.
 * @param {{headers?:{origin?:string}}} req
 * @param {Set<string>|string[]} allowlist lowercase hostnames
 * @returns {boolean}
 */
function isOriginAllowed(req, allowlist) {
  try {
    const o = req && req.headers && req.headers.origin;
    if (!o) return true;
    let host = '';
    try {
      host = new URL(o).hostname.toLowerCase();
    } catch (e) {
      return false;
    }
    if (!host) return false;
    if (allowlist instanceof Set) return allowlist.has(host);
    if (Array.isArray(allowlist)) return allowlist.indexOf(host) >= 0;
    return false;
  } catch (e) {
    return false;
  }
}

function checkEnvelope(raw, maxBytes) {
  try {
    const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    let len = -1;
    if (typeof raw === 'string') len = Buffer.byteLength(raw, 'utf8');
    else if (Buffer.isBuffer(raw)) len = raw.length;
    else if (raw != null && typeof raw.byteLength === 'number') len = raw.byteLength;
    if (len < 0) return { ok: false, code: 'ABUSE' };
    if (len > cap) return { ok: false, code: 'ABUSE' };
    if (len === 0) return { ok: false, code: 'SPOOF' };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'ABUSE' };
  }
}

/**
 * Sliding-window input rate check (default 15/s). Never throws.
 * @param {string} key e.g. ip or ip#nick
 * @param {number} [at] timestamp override (tests)
 * @param {number} [maxPerSec]
 * @returns {{ok:boolean}}
 */
function checkInputWindow(key, at, maxPerSec) {
  try {
    if (!key) return { ok: false };
    const t = typeof at === 'number' ? at : nowMs();
    const max = typeof maxPerSec === 'number' && maxPerSec > 0 ? maxPerSec : 15;
    let arr = inputWindows.get(key);
    if (!arr) {
      arr = [];
      inputWindows.set(key, arr);
    }
    const cutoff = t - 1000;
    while (arr.length && arr[0] <= cutoff) arr.shift();
    arr.push(t);
    if (arr.length > max) return { ok: false };
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

function clearInputWindow(key) {
  try {
    inputWindows.delete(key);
  } catch (e) {}
}

/**
 * Server-side sim invariant monitor. The server simulates authoritatively,
 * so this guards the sim itself plus any state handoffs. Pure, never throws.
 * @param {{x?:number,y?:number,v?:number}} prev
 * @param {{x?:number,y?:number,v?:number}} next
 * @param {number} dt seconds
 * @param {{maxV?:number,maxDv?:number}} [caps]
 * @returns {{ok:boolean, code?:string}}
 */
function physicsSanity(prev, next, dt, caps) {
  try {
    const c = caps && typeof caps === 'object' ? caps : {};
    const maxV = typeof c.maxV === 'number' ? c.maxV : 200;
    const maxDv = typeof c.maxDv === 'number' ? c.maxDv : 5;
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') {
      return { ok: false, code: 'MALFORMED' };
    }
    for (const k of ['x', 'y', 'v']) {
      if (typeof next[k] !== 'number' || !Number.isFinite(next[k])) return { ok: false, code: 'BAD_INPUT' };
      if (typeof prev[k] !== 'number' || !Number.isFinite(prev[k])) return { ok: false, code: 'MALFORMED' };
    }
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0 || dt > 1) {
      return { ok: false, code: 'MALFORMED' };
    }
    if (Math.abs(next.v) > maxV) return { ok: false, code: 'PHYS' };
    if (Math.abs(next.v - prev.v) > maxDv) return { ok: false, code: 'PHYS' };
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxV * dt * 2 + 1) return { ok: false, code: 'PHYS' };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'MALFORMED' };
  }
}

/**
 * Best-effort JSONL audit log with rotation (10MB, keeps .1/.2). Never throws.
 * @param {{ip?:string,nick?:string,code?:string,detail?:string}} entry
 */
function fairplayLog(entry) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ip: entry && entry.ip ? String(entry.ip).slice(0, 45) : null,
      nick: entry && entry.nick ? String(entry.nick).slice(0, 20) : null,
      code: entry && entry.code ? String(entry.code).slice(0, 16) : null,
      detail: entry && entry.detail ? String(entry.detail).slice(0, 200) : null
    }) + '\n';
    const dir = path.dirname(logFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
    try {
      const st = fs.statSync(logFile);
      if (st.size + line.length > MAX_LOG_BYTES) {
        for (let i = 2; i >= 1; i--) {
          try {
            fs.renameSync(logFile + '.' + i, logFile + '.' + (i + 1));
          } catch (e) {}
        }
        try {
          fs.renameSync(logFile, logFile + '.1');
        } catch (e) {}
      }
    } catch (e) {
      // file does not exist yet: fine
    }
    try {
      fs.appendFileSync(logFile, line, 'utf8');
    } catch (e) {}
  } catch (e) {}
}

module.exports = {
  STRIKE_WEIGHTS,
  KICK_AT,
  BAN_AT,
  DECAY_MS,
  DEFAULT_MAX_BYTES,
  recordStrike,
  getStrikes,
  clearStrikes,
  shouldKick,
  shouldBan,
  checkEnvelope,
  isOriginAllowed,
  checkInputWindow,
  clearInputWindow,
  physicsSanity,
  fairplayLog,
  setLogFile
};
