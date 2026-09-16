// Virtual escrow system for betting
// Pure functions, no real money

/**
 * Locks a bet from a player's balance
 * @param {number} balance - current balance
 * @param {number} bet - amount to bet
 * @returns {{balance:number, locked:number}} new balance and locked amount
 * @throws {Error} if bet exceeds balance
 */
function lock(balance, bet) {
  if (!Number.isInteger(bet)) {
    throw new Error('Bet must be an integer');
  }
  if (bet > balance) {
    throw new Error('Insufficient balance');
  }
  if (bet < 0) {
    throw new Error('Bet cannot be negative');
  }
  return {
    balance: balance - bet,
    locked: bet
  };
}

/**
 * Settles the pool after a race
 * @param {number[]} bets - array of bets placed by each player (in order of player index)
 * @param {number} winnerIdx - index of the winning player
 * @returns {{payouts:number[], platformCut:number}} payouts per player and platform cut
 */
function settle(bets, winnerIdx) {
  if (!Array.isArray(bets) || bets.length === 0) {
    throw new Error('Bets must be a non-empty array');
  }
  if (!Number.isInteger(winnerIdx) || winnerIdx < 0 || winnerIdx >= bets.length) {
    throw new Error('Invalid winner index');
  }
  const total = bets.reduce((sum, bet) => sum + bet, 0);
  // Integer balances: round to avoid float dust in stored coins.
  const winnerPayout = Math.round(0.9 * total);
  const platformCut = total - winnerPayout;
  const payouts = bets.map((bet, idx) => (idx === winnerIdx ? winnerPayout : 0));
  return { payouts, platformCut };
}

/**
 * Handles a player quitting: their bet is forfeited and added to the pool
 * @param {number} bet - the bet amount that was locked
 * @returns {number} the forfeited amount to be added to the pool
 */
function quitterForfeit(bet) {
  if (bet < 0) {
    throw new Error('Bet cannot be negative');
  }
  return bet; // the entire bet is forfeited to the pool
}

/**
 * Refunds bets when race is cancelled (less than 2 players remaining)
 * @param {number[]} bets - original bets for all players
 * @param {number[]} remainingPlayerIndices - indices of players who did not quit
 * @returns {{refunds:number[]}} refund amount per player (same order as bets)
 */
function cancelRefund(bets, remainingPlayerIndices) {
  if (!Array.isArray(bets) || bets.length === 0) {
    throw new Error('Bets must be a non-empty array');
  }
  if (!Array.isArray(remainingPlayerIndices)) {
    throw new Error('Remaining player indices must be an array');
  }
  const refunds = bets.map((bet, idx) => 
    remainingPlayerIndices.includes(idx) ? bet : 0
  );
  return { refunds };
}

module.exports = {
  lock,
  settle,
  quitterForfeit,
  cancelRefund
};