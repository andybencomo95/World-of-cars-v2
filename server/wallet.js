// Real-money wallet + immutable ledger for World of Cars (95/5 direct model).
// Integer cents only — floats are rejected everywhere. Phase 1: file-backed
// store with the same interface a Postgres adapter will implement later.
// License/KYC/rails are integrations OUTSIDE this module. Fail-closed gates.

const fs = require('fs');
const path = require('path');

const FEE_BPS = 500; // 5% = 500 basis points
const DEFAULT_MIN_BET_CENTS = 100; // $1.00
const DEFAULT_DAILY_WITHDRAWAL_CENTS = 50000; // $500
const DEFAULT_REVIEW_ABOVE_CENTS = 20000; // $200 -> needsReview

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function assertCents(n, what) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw err('ERR_AMOUNT', 'Invalid amount for ' + (what || 'op'));
  }
}

function assertUserId(id) {
  if (typeof id !== 'string' || !id || id.length > 64 || !/^[A-Za-z0-9:_-]+$/.test(id)) {
    throw err('ERR_USER', 'Invalid user id');
  }
}

function assertLobbyId(id) {
  if (typeof id !== 'string' || !id || id.length > 16 || !/^[A-Za-z0-9]+$/.test(id)) {
    throw err('ERR_LOBBY', 'Invalid lobby id');
  }
}

// ---- File store (atomic journal) ----
function createFileStore(dir) {
  const file = path.join(dir, 'wallet.json');
  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.journal) || typeof data.seq !== 'number') {
        throw err('ERR_STORE', 'Corrupt wallet store (backed up, refusing to reset with value inside)');
      }
      return data;
    } catch (e) {
      if (e && e.code === 'ENOENT') return { journal: [], seq: 0 };
      if (e && e.code === 'ERR_STORE') {
        try {
          fs.renameSync(file, file + '.corrupt-' + Date.now());
        } catch (_) {}
        throw e;
      }
      throw err('ERR_STORE', 'Wallet store unreadable');
    }
  }
  function save(data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  }
  return { load, save };
}

function createWallet(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const currency = o.currency || 'USD';
  if (currency !== 'USD' && currency !== 'USDC') throw err('ERR_CONFIG', 'currency must be USD or USDC');
  const store = o.store || createFileStore(path.join(__dirname, 'data'));
  const limits = {
    minBet: o.minBet || DEFAULT_MIN_BET_CENTS,
    maxBet: typeof o.maxBet === 'number' ? o.maxBet : 0, // 0 = no cap
    dailyWithdrawal: o.dailyWithdrawal || DEFAULT_DAILY_WITHDRAWAL_CENTS,
    reviewAbove: o.reviewAbove || DEFAULT_REVIEW_ABOVE_CENTS
  };
  let allowedCountries = new Set(Array.isArray(o.allowedCountries) ? o.allowedCountries : []);
  const profiles = new Map(); // userId -> { age:number|null, country:string|null, excluded:boolean }
  const withdrawals = new Map(); // userId -> { day:string, total:number }

  function profile(id) {
    let p = profiles.get(id);
    if (!p) {
      p = { age: null, country: null, excluded: false };
      profiles.set(id, p);
    }
    return p;
  }

  function journal() {
    return store.load().journal.map((e) => Object.freeze(Object.assign({}, e)));
  }

  function append(entries) {
    const data = store.load();
    for (const en of entries) {
      data.seq += 1;
      data.journal.push(Object.freeze({
        seq: data.seq,
        ts: new Date().toISOString(),
        debit: en.debit,
        credit: en.credit,
        amount: en.amount,
        ref: en.ref || null,
        memo: en.memo || null
      }));
    }
    store.save(data);
    return data.seq;
  }

  function balanceOf(entries, userId) {
    let b = 0;
    for (const e of entries) {
      if (e.credit === 'user:' + userId) b += e.amount;
      if (e.debit === 'user:' + userId) b -= e.amount;
    }
    return b;
  }

  function getBalance(userId) {
    assertUserId(userId);
    return balanceOf(store.load().journal, userId);
  }

  function checkGate(userId) {
    const p = profile(userId);
    if (p.excluded) throw err('ERR_GATED', 'Self-excluded');
    if (typeof p.age !== 'number' || p.age < 18) throw err('ERR_GATED', 'Age 18+ required');
    if (!p.country || !allowedCountries.has(p.country)) throw err('ERR_GATED', 'Jurisdiction not allowed');
  }

  function setAgeCountry(userId, age, country) {
    assertUserId(userId);
    const p = profile(userId);
    if (typeof age === 'number') p.age = Math.floor(age);
    if (typeof country === 'string') p.country = country.toUpperCase().slice(0, 4);
    return { age: p.age, country: p.country };
  }

  function setAllowedCountries(list) {
    allowedCountries = new Set(Array.isArray(list) ? list : []);
  }

  function selfExclude(userId) {
    assertUserId(userId);
    profile(userId).excluded = true;
  }

  function isExcluded(userId) {
    assertUserId(userId);
    return profile(userId).excluded === true;
  }

  let feeWallet = null; // { address, network } — platform fee destination (EVM 0x)

  function setFeeWallet(address, network) {
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw err('ERR_ADDRESS', 'Invalid fee wallet address');
    }
    const net = typeof network === 'string' && network ? network.slice(0, 24) : 'UNSET';
    feeWallet = { address, network: net };
    return { address: feeWallet.address, network: feeWallet.network };
  }

  function getFeeWallet() {
    return feeWallet ? { address: feeWallet.address, network: feeWallet.network } : null;
  }

  function getFeesBalance() {
    const data = store.load();
    let b = 0;
    for (const e of data.journal) {
      if (e.credit === 'fees') b += e.amount;
      if (e.debit === 'fees') b -= e.amount;
    }
    return b;
  }

  // Moves accumulated SETTLED fees to the configured platform wallet.
  // The fees account only ever receives settle/cancel entries, so this is
  // verified + finalized money by construction. Returns txRef:null because
  // on-chain broadcast is a later rail integration (keys never live in repo).
  function payoutFees() {
    if (!feeWallet) throw err('ERR_CONFIG', 'Fee wallet not configured');
    const bal = getFeesBalance();
    if (bal <= 0) throw err('ERR_STATE', 'No fees to pay out');
    append([
      { debit: 'fees', credit: 'payout:' + feeWallet.address, amount: bal, ref: 'fee-payout', memo: feeWallet.network + '|pending-rail' }
    ]);
    return { amount: bal, to: feeWallet.address, network: feeWallet.network, txRef: null };
  }

  function setLimits(nl) {
    const l = nl && typeof nl === 'object' ? nl : {};
    if (l.minBet !== undefined) limits.minBet = l.minBet;
    if (l.maxBet !== undefined) limits.maxBet = l.maxBet;
    if (l.dailyWithdrawal !== undefined) limits.dailyWithdrawal = l.dailyWithdrawal;
    if (l.reviewAbove !== undefined) limits.reviewAbove = l.reviewAbove;
    return Object.assign({}, limits);
  }

  function deposit(userId, cents) {
    assertUserId(userId);
    assertCents(cents, 'deposit');
    checkGate(userId);
    append([{ debit: 'house', credit: 'user:' + userId, amount: cents, ref: 'deposit', memo: currency }]);
    return getBalance(userId);
  }

  function lobbySettled(entries, lobbyId) {
    return entries.some((e) => e.ref === 'settle:' + lobbyId || e.ref === 'cancel:' + lobbyId);
  }

  function placeBet(userId, lobbyId, cents) {
    assertUserId(userId);
    assertLobbyId(lobbyId);
    assertCents(cents, 'bet');
    checkGate(userId);
    if (cents < limits.minBet) throw err('ERR_LIMIT', 'Below minimum bet');
    if (limits.maxBet > 0 && cents > limits.maxBet) throw err('ERR_LIMIT', 'Above maximum bet');
    const data = store.load();
    if (lobbySettled(data.journal, lobbyId)) throw err('ERR_STATE', 'Lobby already settled');
    if (balanceOf(data.journal, userId) < cents) throw err('ERR_FUNDS', 'Insufficient funds');
    append([
      { debit: 'user:' + userId, credit: 'escrow:' + lobbyId, amount: cents, ref: 'bet:' + lobbyId, memo: currency }
    ]);
    return getBalance(userId);
  }

  function forfeitBet(userId, lobbyId) {
    assertUserId(userId);
    assertLobbyId(lobbyId);
    const data = store.load();
    if (lobbySettled(data.journal, lobbyId)) throw err('ERR_STATE', 'Lobby already settled');
    const mine = data.journal.filter(
      (e) => e.debit === 'user:' + userId && e.credit === 'escrow:' + lobbyId && e.memo !== 'settled'
    );
    if (!mine.length) throw err('ERR_STATE', 'No open bet to forfeit');
    // Mark as forfeited (stays in pot): append a marker entry of 0? No — mutate nothing.
    // Forfeit is represented by a marker so cancel() skips refunding it.
    append([
      { debit: 'user:' + userId, credit: 'escrow:' + lobbyId, amount: 0, ref: 'forfeit:' + lobbyId, memo: 'forfeit' }
    ]);
    return true;
  }

  function potOf(entries, lobbyId) {
    let pot = 0;
    for (const e of entries) {
      if (e.credit === 'escrow:' + lobbyId && e.memo !== 'settled' && e.amount > 0) pot += e.amount;
    }
    return pot;
  }

  function settleRace(lobbyId, winnerId) {
    assertLobbyId(lobbyId);
    assertUserId(winnerId);
    const data = store.load();
    if (lobbySettled(data.journal, lobbyId)) throw err('ERR_STATE', 'Lobby already settled');
    const pot = potOf(data.journal, lobbyId);
    if (pot <= 0) throw err('ERR_STATE', 'Empty pot');
    const winnerShare = Math.floor((pot * (10000 - FEE_BPS)) / 10000);
    const fee = pot - winnerShare;
    const outs = [
      { debit: 'escrow:' + lobbyId, credit: 'user:' + winnerId, amount: winnerShare, ref: 'settle:' + lobbyId, memo: 'settled' }
    ];
    if (fee > 0) {
      outs.push({ debit: 'escrow:' + lobbyId, credit: 'fees', amount: fee, ref: 'settle:' + lobbyId, memo: 'settled' });
    }
    append(outs);
    return { pot, winnerShare, fee, winner: getBalance(winnerId) };
  }

  function cancelRace(lobbyId) {
    assertLobbyId(lobbyId);
    const data = store.load();
    if (lobbySettled(data.journal, lobbyId)) throw err('ERR_STATE', 'Lobby already settled');
    const forfeitedUsers = new Set(
      data.journal
        .filter((e) => e.ref === 'forfeit:' + lobbyId)
        .map((e) => e.debit.replace(/^user:/, ''))
    );
    const outs = [];
    let forfeitedTotal = 0;
    for (const e of data.journal) {
      if (e.credit !== 'escrow:' + lobbyId || e.memo === 'settled' || e.amount <= 0) continue;
      const who = e.debit.replace(/^user:/, '');
      if (forfeitedUsers.has(who)) { forfeitedTotal += e.amount; continue; }
      outs.push({ debit: 'escrow:' + lobbyId, credit: 'user:' + who, amount: e.amount, ref: 'cancel:' + lobbyId, memo: 'settled' });
    }
    if (!outs.length && forfeitedTotal <= 0) throw err('ERR_STATE', 'Nothing to refund');
    if (forfeitedTotal > 0) {
      outs.push({ debit: 'escrow:' + lobbyId, credit: 'fees', amount: forfeitedTotal, ref: 'cancel:' + lobbyId, memo: 'settled' });
    }
    append(outs);
    return { refunded: outs.length - (forfeitedTotal > 0 ? 1 : 0), forfeited: forfeitedTotal };
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function withdraw(userId, cents) {
    assertUserId(userId);
    assertCents(cents, 'withdraw');
    checkGate(userId);
    const data = store.load();
    if (balanceOf(data.journal, userId) < cents) throw err('ERR_FUNDS', 'Insufficient funds');
    const day = todayKey();
    let w = withdrawals.get(userId);
    if (!w || w.day !== day) w = { day, total: 0 };
    if (w.total + cents > limits.dailyWithdrawal) throw err('ERR_LIMIT', 'Daily withdrawal cap');
    w.total += cents;
    withdrawals.set(userId, w);
    append([{ debit: 'user:' + userId, credit: 'house', amount: cents, ref: 'withdraw', memo: currency }]);
    return { amount: cents, balance: getBalance(userId), needsReview: cents >= limits.reviewAbove };
  }

  return {
    currency,
    journal,
    setFeeWallet,
    getFeeWallet,
    getFeesBalance,
    payoutFees,
    getBalance,
    setAgeCountry,
    setAllowedCountries,
    selfExclude,
    isExcluded,
    setLimits,
    deposit,
    placeBet,
    forfeitBet,
    settleRace,
    cancelRace,
    withdraw,
    FEE_BPS
  };
}

module.exports = { createWallet, createFileStore, FEE_BPS };
