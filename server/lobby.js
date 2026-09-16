// Lobby management for online racing
// Handles player connections, betting, and reconnects

const crypto = require('crypto');

/**
 * Generates a random 4-letter uppercase code without ambiguous characters (O, I)
 * @returns {string} 4-letter code
 */
function generateCode() {
  const allowedChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Excluding O and I
  let code = '';
  for (let i = 0; i < 4; i++) {
    const randomIndex = Math.floor(crypto.randomBytes(1)[0] / 256 * allowedChars.length);
    code += allowedChars[randomIndex];
  }
  return code;
}

class Lobby {
  /**
   * @param {string} code - 4-letter lobby code
   */
  constructor(code) {
    this.code = code;
    /** @type {Array<{id:string, nick:string, ip:string, bet:number|null, lastSeen:number}>} */
    this.players = [];
    this.state = 'waiting'; // waiting, countdown, racing, finished
    /** @type {number} timestamp when countdown started (for racing state) */
    this.countdownStart = null;
    /** @type {number} duration of countdown in milliseconds */
    this.COUNTDOWN_DURATION = 3000; // 3 seconds
    /** @type {number} duration of inactivity before removal in milliseconds */
    this.INACTIVITY_THRESHOLD = 30000; // 30 seconds
    /** @type {number} duration of reconnect window in milliseconds */
    this.RECONNECT_WINDOW = 15000; // 15 seconds
    /** @type {Map<string, number>} temporary storage for bet amounts placed (socketId -> amount) */
    this.pendingBets = new Map();
    /** @type {Map<string, number>} lastSeen for each player (by socketId) for inactivity check */
    this.lastSeenMap = new Map();
    /** @type {number} accumulated forfeited bets (quitters) kept in the pot */
    this.forfeitedPool = 0;
  }

  /**
   * Adds a player to the lobby
   * @param {string} nick - player nickname
   * @param {string} ip - player IP address
   * @param {string} socketId - unique socket identifier
   * @returns {{success:boolean, player:Object|null, error:string|null}}
   */
  addPlayer(nick, ip, socketId) {
    // Check if lobby is joinable (only waiting state allows new players)
    if (this.state !== 'waiting') {
      return { success: false, player: null, error: 'Lobby is not joinable' };
    }
    if (this.players.length >= 4) {
      return { success: false, player: null, error: 'Lobby is full' };
    }
    // Check if nick is already taken in this lobby
    if (this.players.some(p => p.nick === nick)) {
      return { success: false, player: null, error: 'Nickname already taken' };
    }
    const player = {
      id: socketId,
      nick,
      ip,
      bet: null, // no bet placed yet
      lastSeen: Date.now(),
      carState: null,
      totalProgress: 0,
      finished: false,
      finishOrder: null
    };
    this.players.push(player);
    this.lastSeenMap.set(socketId, Date.now());
    return { success: true, player, error: null };
  }

  /**
   * Removes a player from the lobby (quit or disconnect)
   * @param {string} socketId
   * @returns {{success:boolean, player:Object|null, betForfeited:number|null, error:string|null}}
   *          betForfeited: the amount to be added to the pool if the player had placed a bet and quit
   */
  removePlayer(socketId) {
    const index = this.players.findIndex(p => p.id === socketId);
    if (index === -1) {
      return { success: false, player: null, betForfeited: null, error: 'Player not found' };
    }
    const player = this.players[index];
    // Remove from players array
    this.players.splice(index, 1);
    // Remove from lastSeenMap
    this.lastSeenMap.delete(socketId);
    // If the player had placed a bet, it is forfeited (goes to pool)
    let betForfeited = null;
    if (player.bet !== null) {
      betForfeited = player.bet;
      this.forfeitedPool += betForfeited;
      // Clear any pending bet
      this.pendingBets.delete(socketId);
    }
    return { success: true, player, betForfeited, error: null };
  }

  /**
   * Places a bet for a player
   * @param {string} socketId
   * @param {number} amount - amount to bet
   * @returns {{success:boolean, locked:number|null, error:string|null}}
   *          locked: the amount that was locked (to be subtracted from balance)
   */
  placeBet(socketId, amount) {
    // Betting is allowed only in waiting state (once countdown starts, no more bets)
    if (this.state !== 'waiting') {
      return { success: false, locked: null, error: 'Betting is not open' };
    }
    if (amount <= 0) {
      return { success: false, locked: null, error: 'Bet must be positive' };
    }
    const player = this.players.find(p => p.id === socketId);
    if (!player) {
      return { success: false, locked: null, error: 'Player not in lobby' };
    }
    if (player.bet !== null) {
      return { success: false, locked: null, error: 'Bet already placed' };
    }
    // Lock the bet (we just record it, actual locking of balance is done elsewhere)
    player.bet = amount;
    this.pendingBets.set(socketId, amount);
    return { success: true, locked: amount, error: null };
  }

  /**
   * Updates lastSeen for a player (called on any message from client)
   * @param {string} socketId
   */
  updateLastSeen(socketId) {
    const player = this.players.find(p => p.id === socketId);
    if (player) {
      player.lastSeen = Date.now();
      this.lastSeenMap.set(socketId, Date.now());
    }
  }

  /**
   * Attempts to reconnect a player by nick and lobby code
   * @param {string} nick
   * @param {string} socketId - new socket id
   * @returns {{success:boolean, player:Object|null, error:string|null}}
   */
  reconnectPlayer(nick, socketId) {
    // Find player by nick in this lobby
    const playerIndex = this.players.findIndex(p => p.nick === nick);
    if (playerIndex === -1) {
      return { success: false, player: null, error: 'Player not found in lobby' };
    }
    const player = this.players[playerIndex];
    // Check if reconnect is within window (based on lastSeen)
    const now = Date.now();
    if (now - player.lastSeen > this.RECONNECT_WINDOW) {
      return { success: false, player: null, error: 'Reconnect window expired' };
    }
    const oldSocketId = player.id;
    // Update the socket id and lastSeen, clear disconnected flag
    player.id = socketId;
    player.lastSeen = now;
    player.disconnected = false;
    player.disconnectAt = null;
    this.lastSeenMap.set(socketId, now);
    if (oldSocketId !== socketId) {
      this.lastSeenMap.delete(oldSocketId);
      this.pendingBets.delete(oldSocketId);
    }
    // If they had a pending bet, restore it in pendingBets (using the new socketId)
    if (player.bet !== null) {
      this.pendingBets.set(socketId, player.bet);
    }
    return { success: true, player, error: null };
  }

  /**
   * Gets the number of players in the lobby
   * @returns {number}
   */
  getPlayerCount() {
    return this.players.length;
  }

  /**
   * Checks if the lobby has enough players to start (quorum 2)
   * @returns {boolean}
   */
  hasQuorum() {
    return this.players.length >= 2;
  }

  /**
   * Checks if the lobby is full (max 4)
   * @returns {boolean}
   */
  isFull() {
    return this.players.length >= 4;
  }

  /**
   * Gets an array of players who have placed their bets
   * @returns {Array<{id:string, nick:string, ip:string, bet:number}>}
   */
  getPlayersWithBets() {
    return this.players.filter(p => p.bet !== null).map(p => ({
      id: p.id,
      nick: p.nick,
      ip: p.ip,
      bet: p.bet
    }));
  }

  /**
   * Checks if all players have placed their bets
   * @returns {boolean}
   */
  allBetsPlaced() {
    return this.players.every(p => p.bet !== null);
  }

  /**
   * Clears all bets (used after race start or cancellation)
   */
  clearBets() {
    for (const player of this.players) {
      player.bet = null;
    }
    this.pendingBets.clear();
  }

  /**
   * Removes players who have been inactive for more than INACTIVITY_THRESHOLD
   * @returns {Array<{id:string, nick:string, ip:string, betForfeited:number|null}>} list of removed players
   */
  removeInactivePlayers() {
    const now = Date.now();
    const removed = [];
    // We'll iterate backwards to safely remove
    for (let i = this.players.length - 1; i >= 0; i--) {
      const player = this.players[i];
      const lastSeen = this.lastSeenMap.get(player.id) || 0;
      if (now - lastSeen > this.INACTIVITY_THRESHOLD) {
        // Treat as quit: remove and forfeit bet if any (kept in pot)
        const betForfeited = player.bet !== null ? player.bet : null;
        if (betForfeited !== null) this.forfeitedPool += betForfeited;
        // Remove from players array
        this.players.splice(i, 1);
        // Remove from lastSeenMap
        this.lastSeenMap.delete(player.id);
        // Clear pending bet
        this.pendingBets.delete(player.id);
        removed.push({
          id: player.id,
          nick: player.nick,
          ip: player.ip,
          betForfeited
        });
      }
    }
    return removed;
  }

  /**
   * Starts the countdown to racing
   * @returns {boolean} true if countdown started, false otherwise
   */
  startCountdown() {
    if (this.state !== 'waiting' || !this.hasQuorum()) {
      return false;
    }
    // Lock bets: no more bets allowed after countdown starts
    this.state = 'countdown';
    this.countdownStart = Date.now();
    return true;
  }

  /**
   * Updates the lobby state based on time (called periodically)
   * @returns {string|null} new state if changed, null otherwise
   */
  updateState() {
    const now = Date.now();
    if (this.state === 'countdown') {
      if (now - this.countdownStart >= this.COUNTDOWN_DURATION) {
        this.state = 'racing';
        this.countdownStart = null;
        for (const pl of this.players) {
          pl.carState = { x: 0, y: 0, angle: 0, v: 0, progress: 0, lap: 0 };
          pl.totalProgress = 0;
          pl.finished = false;
          pl.finishOrder = null;
        }
        this.finishCounter = 0;
        return 'racing';
      }
    } else if (this.state === 'racing') {
      // Check if we should transition to finished? 
      // That will be determined by the simulation (when all players finish laps?) 
      // We'll leave that to the server to set based on race completion.
      // For now, we don't auto-transition from racing.
    } else if (this.state === 'finished') {
      // Optionally, after some time in finished, we could reset to waiting if empty?
      // Not implemented.
    }
    return null;
  }

  /**
   * Gets the remaining countdown time in milliseconds, or 0 if not in countdown
   * @returns {number}
   */
  getCountdownRemaining() {
    if (this.state !== 'countdown' || !this.countdownStart) return 0;
    const elapsed = Date.now() - this.countdownStart;
    const remaining = this.COUNTDOWN_DURATION - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Gets the current lobby state for debugging
   * @returns {Object}
   */
  getState() {
    return {
      code: this.code,
      playerCount: this.players.length,
      state: this.state,
      countdownRemaining: this.getCountdownRemaining(),
      players: this.players.map(p => ({
        id: p.id,
        nick: p.nick,
        ip: p.ip,
        bet: p.bet,
        lastSeen: new Date(p.lastSeen).toISOString()
      }))
    };
  }
}

module.exports = { Lobby, generateCode };