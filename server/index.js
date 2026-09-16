// WebSocket server for World of Cars online racing
// Slice 2: lobby codes, WS protocol, reconnect

const WebSocket = require('ws');
const { generateCode, Lobby } = require('./lobby');
const { isBanned, ban } = require('./bans');
const fairplay = require('./fairplay');
const { lock, settle, quitterForfeit, cancelRefund } = require('./escrow');
const { createInitialState, update, STEP, TRACK_LENGTH } = require('./sim');
const { 
  validateLobbyCode, 
  validateNick, 
  validateBet, 
  validateInputs, 
  createRateLimiter,
  MSG_TYPE,
  validateMessage,
  validateEnvelope,
  MAX_MESSAGE_BYTES
} = require('./protocol');

const crypto = require('crypto');
const PORT = process.env.PORT || 3000; // Render inyecta PORT; local usa 3000
const ORIGIN_ALLOWLIST = new Set(
  (process.env.ORIGIN_ALLOWLIST || 'worldofcarsmakemoney.dev,localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);
const WSS_SERVER = new WebSocket.Server({
  port: PORT,
  maxPayload: 4096,
  verifyClient: (info, cb) => {
    try {
      if (fairplay.isOriginAllowed(info.req, ORIGIN_ALLOWLIST)) return cb(true);
    } catch (e) {}
    try { cb(false, 403, 'Forbidden'); } catch (e) {}
  }
});
// ---- Fair-play + hardening (essential shield) ----
const MAX_SOCKETS = 100;
const MAX_SOCKETS_PER_IP = 3;
const MAX_EARLY_QUEUE = 20;
const HEARTBEAT_MS = 30000;
let activeSockets = 0;
const ipSockets = new Map(); // ip -> count
function getClientIp(req) {
  try {
    const fwd = req && req.headers && req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) {
      const first = fwd.split(',')[0].trim();
      if (/^[A-Za-z0-9.:]{3,45}$/.test(first)) return first;
    }
  } catch (e) {}
  try {
    const ra = req && req.socket && req.socket.remoteAddress;
    if (typeof ra === 'string' && ra) return ra;
  } catch (e) {}
  return 'unknown';
}
function sendErr(ws, message) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message }));
    }
  } catch (e) {}
}
function penalize(ws, ip, nick, code, detail) {
  try { fairplay.recordStrike(ip, code); } catch (e) {}
  try { fairplay.fairplayLog({ ip, nick, code, detail }); } catch (e) {}
  let counts = 0;
  try { counts = fairplay.getStrikes(ip); } catch (e) {}
  if (counts >= fairplay.BAN_AT) {
    try { ban(ip, 'fairplay-' + code, 60 * 60 * 1000).catch(() => {}); } catch (e) {}
    try { ws.close(4403, 'Banned'); } catch (e) {}
    return 'banned';
  }
  if (counts >= fairplay.KICK_AT) {
    try { ws.close(4400, 'Kicked for fair-play violations'); } catch (e) {}
    return 'kicked';
  }
  return 'struck';
}
setInterval(() => {
  try {
    WSS_SERVER.clients.forEach((ws) => {
      try {
        if (ws._wocAlive === false) { try { ws.terminate(); } catch (e) {} return; }
        ws._wocAlive = false;
        try { ws.ping(() => {}); } catch (e) {}
      } catch (e) {}
    });
  } catch (e) {}
}, HEARTBEAT_MS);

console.log(`WebSocket server listening on port ${PORT}`);

// In-memory storage for lobbies (key: lobby code)
const lobbies = new Map();
// We'll create a default lobby for testing
const DEFAULT_LOBBY_CODE = generateCode();
lobbies.set(DEFAULT_LOBBY_CODE, new Lobby(DEFAULT_LOBBY_CODE));
// NOTE: lobby codes are never logged (log readers could join any lobby).

// Map socket to lobby code and player info
const socketInfoMap = new Map(); // socket -> { lobbyCode, playerId, nick, ip, lastMessageTime }
// Pending network-drop reconnects: lobbyCode#nick -> { timeoutId, socketInfo } (15s window)
const nickToDisconnectInfo = new Map();
const RECONNECT_WINDOW_MS = 15000;

// Rate limiter per socket (30 messages/sec)
const rateLimiters = new Map(); // socket -> rate limiter function
// Virtual-coin balances live in server/balances.js (TM-001: daily per-IP
// faucet, no phantom refills). Same names, hardened semantics.
const { INITIAL_BALANCE, loadBalances, loadFaucets, saveBalances,
  saveFaucets, getBalance, updateBalance, claimFaucet, todayKey } = require('./balances');

// Helper to get lobby by code
function getLobby(code) {
  return lobbies.get(code);
}

// Helper to get player info from socket
function getSocketInfo(ws) {
  return socketInfoMap.get(ws);
}

// Helper to get player from socket info and lobby
function getPlayerFromSocketInfo(socketInfo) {
  if (!socketInfo) return null;
  const lobby = getLobby(socketInfo.lobbyCode);
  if (!lobby) return null;
  return lobby.players.find(p => p.id === socketInfo.playerId);
}

// Handle new connection
WSS_SERVER.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  console.log(`New connection from ${ip}`);

  // Buffer messages arriving before the async ban check finishes.
  // earlyHandler only queues; once accepted it ignores (the real handler below runs).
  const _earlyQueue = [];
  let _accepted = false;
  function earlyHandler(message) {
    if (!_accepted) {
      if (_earlyQueue.length >= MAX_EARLY_QUEUE) { try { ws.close(4409, 'Too many pending'); } catch (e) {} return; }
      _earlyQueue.push(message);
    }
  }
  ws.on('message', earlyHandler);

  // Check if IP is banned
  isBanned(ip).then(banned => {
    if (banned) {
      console.log(`Connection rejected: IP ${ip} is banned`);
      ws.close(4403, 'IP banned'); // Use 4403 as per spec
      return;
    }

    if (activeSockets >= MAX_SOCKETS) { try { ws.close(4409, 'Server full'); } catch (e) {} return; }
    const ipc = ipSockets.get(ip) || 0;
    if (ipc >= MAX_SOCKETS_PER_IP) { try { ws.close(4408, 'Too many connections'); } catch (e) {} return; }
    // Connection accepted
    console.log(`Connection accepted from ${ip}`);
    _accepted = true;
    ws._wocCounted = true;
    activeSockets += 1;
    ipSockets.set(ip, ipc + 1);
    ws._wocAlive = true;
    ws.on('pong', () => { try { ws._wocAlive = true; } catch (e) {} });

    // Create rate limiter for this socket
    const rateLimiter = createRateLimiter(30);
    rateLimiters.set(ws, rateLimiter);

    // Send welcome message
    ws.send(JSON.stringify({
      type: MSG_TYPE.WELCOME,
      message: 'Connected to World of Cars server',
      defaultLobbyCode: DEFAULT_LOBBY_CODE
    }));

    // Handle messages from client
    ws.on('message', (message) => {
      const _sinfo0 = getSocketInfo(ws);
      const _nick0 = _sinfo0 && _sinfo0.nick ? _sinfo0.nick : null;
      const _env = fairplay.checkEnvelope(message, MAX_MESSAGE_BYTES);
      if (!_env.ok) {
        penalize(ws, ip, _nick0, 'ABUSE', 'envelope');
        sendErr(ws, 'Message too large');
        return;
      }
      // Rate limit
      const rateLimiter = rateLimiters.get(ws);
      if (!rateLimiter || !rateLimiter()) {
        penalize(ws, ip, _nick0, 'FLOOD', 'global-rate');
        ws.send(JSON.stringify({
          type: MSG_TYPE.ERROR,
          message: 'Rate limit exceeded. Max 30 messages per second.'
        }));
        return;
      }

      let data;
      try {
        data = JSON.parse(message);
      } catch (e) {
        penalize(ws, ip, _nick0, 'SPOOF', 'bad-json');
        ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Invalid JSON' }));
        return;
      }

      // Validate message structure
      const validation = validateMessage(data);
      if (!validation.valid) {
        penalize(ws, ip, _nick0, 'SPOOF', 'schema');
        ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Invalid message' }));
        return;
      }

      // NOTE: per-message logging removed (noise); abuse goes to fairplay.log.

      // Update last message time for this socket
      const socketInfo = getSocketInfo(ws);
      if (socketInfo) {
        socketInfo.lastMessageTime = Date.now();
      }

      // Handle message based on type
      switch (data.type) {
        case MSG_TYPE.HELLO:
          handleHello(ws, data, ip);
          break;
        case MSG_TYPE.CREATE:
          handleCreate(ws, data, ip);
          break;
        case MSG_TYPE.JOIN:
          handleJoin(ws, data, ip);
          break;
        case MSG_TYPE.BET:
          handleBet(ws, data, ip);
          break;
        case MSG_TYPE.INPUT:
          handleInput(ws, data, ip);
          break;
        case MSG_TYPE.START:
          handleStart(ws, data, ip);
          break;
        case MSG_TYPE.LEAVE:
          handleLeave(ws, data, ip);
          break;
        default:
          ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Unhandled message type' }));
      }
    });

    // Flush messages buffered during the ban check through the real handler.
    {
      const _real = ws.listeners('message').find((fn) => fn !== earlyHandler);
      while (_earlyQueue.length) {
        const _m = _earlyQueue.shift();
        if (_real) { try { _real.call(ws, _m); } catch (e) {} }
      }
    }

    // Handle connection close
    ws.on('close', (code, reason) => {
      try {
        if (ws._wocCounted) {
          ws._wocCounted = false;
          activeSockets = Math.max(0, activeSockets - 1);
          const _c = (ipSockets.get(ip) || 1) - 1;
          if (_c <= 0) ipSockets.delete(ip); else ipSockets.set(ip, _c);
        }
        rateLimiters.delete(ws);
      } catch (e) {}
      console.log(`Connection closed: ${ip} code=${code}`);
      // Clean up socket mapping and rate limiter, keep lobby slot for reconnect
      const socketInfo = socketInfoMap.get(ws);
      if (socketInfo) {
        socketInfoMap.delete(ws);
        rateLimiters.delete(ws);
        // Keep lobby slot 15s for reconnect (network drop)
        handleCloseDelayed(socketInfo);
      }
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error(`WebSocket error: ${err.message}`);
    });
  }).catch(err => {
    console.error(`Error checking ban status: ${err.message}`);
    ws.close(4000, 'Internal error');
  });
});

// Message handlers
function handleHello(ws, data, ip) {
  const { nick } = data;
  if (!validateNick(nick)) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Invalid nick' }));
    return;
  }
  const prev = getSocketInfo(ws) || {};
  socketInfoMap.set(ws, {
    lobbyCode: prev.lobbyCode || null,
    playerId: prev.playerId || null,
    nick, ip,
    lastMessageTime: Date.now(),
    latestInputs: prev.latestInputs || null
  });
  ws.send(JSON.stringify({
    type: MSG_TYPE.WELCOME,
    message: 'Hello received',
    defaultLobbyCode: DEFAULT_LOBBY_CODE
  }));
}

function handleCreate(ws, data, ip) {
  const socketInfo = getSocketInfo(ws);
  if (socketInfo && socketInfo.lobbyCode) {
    handleLeave(ws, { type: MSG_TYPE.LEAVE }, ip);
  }
  // Generate a new lobby code
  const code = generateCode();
  const lobby = new Lobby(code);
  lobbies.set(code, lobby);
  // NOTE: lobby codes are never logged (see above).

  // Add player to the lobby
  const nick = socketInfo ? socketInfo.nick : 'Anonymous'; // We don't have nick yet from hello
  // Actually, we should have sent hello first. We'll require hello before create/join.
  // For now, we'll use a default nick if not set.
  if (!socketInfo || !socketInfo.nick) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Please send hello first' }));
    // Clean up the lobby we just created? We'll leave it, but it will be empty.
    return;
  }
  const nickName = socketInfo.nick;
  const addResult = lobby.addPlayer(nickName, ip, crypto.randomUUID());
  if (!addResult.success) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: addResult.error }));
    lobbies.delete(code); // Remove the lobby we just created
    return;
  }
  // Store socket info
  socketInfoMap.set(ws, {
    lobbyCode: code,
    playerId: addResult.player.id,
    nick: nickName,
    ip,
    lastMessageTime: Date.now()
  });
  // Notify player
  ws.send(JSON.stringify({
    type: MSG_TYPE.WELCOME,
    message: `Lobby created with code: ${code}`,
    defaultLobbyCode: code
  }));
  try { broadcastLobbyState(lobby); } catch (e) {}
  // Also notify other players? None yet.
}

function handleJoin(ws, data, ip) {
  const { code } = data;
  if (!validateLobbyCode(code)) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Invalid lobby code' }));
    return;
  }
  const lobby = getLobby(code);
  if (!lobby) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Lobby not found' }));
    return;
  }
  const _prevInfo = getSocketInfo(ws);
  if (_prevInfo && _prevInfo.lobbyCode) {
    // Leave current lobby first (only if actually in one)
    handleLeave(ws, { type: MSG_TYPE.LEAVE }, ip);
  }
  const socketInfo = getSocketInfo(ws) || _prevInfo;
  // We need the nick from socketInfo (from hello)
  if (!socketInfo || !socketInfo.nick) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Please send hello first' }));
    return;
  }
  const nickName = socketInfo.nick;
  const key = code + '#' + nickName;
  const disconnectEntry = nickToDisconnectInfo.get(key);
  if (disconnectEntry) {
    // There is a disconnected player with same nick+lobbyCode within window
    clearTimeout(disconnectEntry.timeoutId);
    nickToDisconnectInfo.delete(key);
    const newPlayerId = crypto.randomUUID();
    socketInfo.playerId = newPlayerId;
    const reconnectResult = lobby.reconnectPlayer(nickName, newPlayerId);
    if (reconnectResult.success) {
      // Reconnected successfully
      socketInfoMap.set(ws, {
        lobbyCode: code,
        playerId: newPlayerId,
        nick: nickName,
        ip: socketInfo.ip,
        lastMessageTime: Date.now()
      });
      const rateLimiter = createRateLimiter(30);
      rateLimiters.set(ws, rateLimiter);
      ws.send(JSON.stringify({
        type: MSG_TYPE.WELCOME,
        message: `Joined lobby: ${code}`,
        defaultLobbyCode: DEFAULT_LOBBY_CODE
      }));
      return;
    }
    // If reconnect failed, fall through to treat as new player (should not happen if player still in lobby)
  }
  // Normal join (new player or reconnect failed)
  const addResult = lobby.addPlayer(nickName, ip, crypto.randomUUID());
  if (!addResult.success) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: addResult.error }));
    return;
  }
  // Store socket info
  socketInfoMap.set(ws, {
    lobbyCode: code,
    playerId: addResult.player.id,
    nick: nickName,
    ip,
    lastMessageTime: Date.now()
  });
  const rateLimiter = createRateLimiter(30);
  rateLimiters.set(ws, rateLimiter);
  // Notify player
  ws.send(JSON.stringify({
    type: MSG_TYPE.WELCOME,
    message: `Joined lobby: ${code}`,
    defaultLobbyCode: DEFAULT_LOBBY_CODE
  }));
  // Notify others in lobby? We'll do state broadcast later.
}

// TM-002: serialize bet processing. The in-flight flag rejects double
// submits instantly; the chain closes the async load-check-save race
// (including cross-player lost updates on the balance file).
const betInFlight = new Set(); // `${lobbyCode}#${playerId}`
let _betChain = Promise.resolve();

function handleBet(ws, data, ip) {
  const { amount } = data;
  const socketInfo = getSocketInfo(ws);
  if (!socketInfo) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Not in a lobby' }));
    return;
  }
  const lobby = getLobby(socketInfo.lobbyCode);
  if (!lobby) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Lobby not found' }));
    return;
  }
  // Validate bet amount
  if (!validateBet(amount)) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Bet must be an integer >= 1' }));
    return;
  }
  // TM-002: fast-reject double submits, then serialize the whole
  // load-check-save pipeline so concurrent bets cannot double-spend.
  const flightKey = `${socketInfo.lobbyCode}#${socketInfo.playerId}`;
  if (betInFlight.has(flightKey)) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Bet already processing' }));
    return;
  }
  betInFlight.add(flightKey);
  _betChain = _betChain.then(() => processBet(ws, data, socketInfo, lobby)).catch((err) => {
    console.error('Bet pipeline error:', err && err.message);
  }).finally(() => {
    betInFlight.delete(flightKey);
  });
}

// Runs inside _betChain: no two bets interleave here (TM-002).
async function processBet(ws, data, socketInfo, lobby) {
  try {
    const { amount } = data;
    if (!validateBet(amount)) {
      ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Bet must be an integer >= 1' }));
      return;
    }
    const { nick, ip } = socketInfo;
    const balances = await loadBalances();
    const faucets = await loadFaucets();
    // TM-001: the faucet (once per IP per day) is claimed explicitly and is
    // always persisted — even when the bet below fails — so it cannot re-arm.
    claimFaucet(balances, faucets, nick, ip, todayKey());
    const balance = getBalance(balances, nick, ip);
    // Attempt to lock the bet against the fresh balance
    let locked;
    try {
      locked = lock(balance, amount).locked;
    } catch (e) {
      await saveBalances(balances);
      await saveFaucets(faucets);
      ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Bet failed' }));
      return;
    }
    // Record the bet in the lobby (amount already validated above)
    const betResult = lobby.placeBet(socketInfo.playerId, amount);
    if (!betResult.success) {
      // Nothing was deducted: balances untouched except the faucet claim.
      await saveBalances(balances);
      await saveFaucets(faucets);
      ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: betResult.error }));
      return;
    }
    // Deduct the locked amount and persist both stores together
    updateBalance(balances, nick, ip, -locked);
    await saveBalances(balances);
    await saveFaucets(faucets);
    ws.send(JSON.stringify({
      type: MSG_TYPE.WELCOME,
      message: `Bet placed: ${amount}`
    }));
  } catch (err) {
    console.error('Error processing bet:', err);
    try {
      ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Internal error' }));
    } catch (e) {}
  }
}

function handleInput(ws, data, ip) {
  const inputs = data.inputs || { throttle: data.throttle, brake: data.brake, steer: data.steer };
  const socketInfo = getSocketInfo(ws);
  if (!socketInfo) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Not in a lobby' }));
    return;
  }
  const lobby = getLobby(socketInfo.lobbyCode);
  if (!lobby) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Lobby not found' }));
    return;
  }
  // Per-type input rate (15/s sliding window)
  try {
    // Keyed by ip#playerId (stable UUID per join): per-player budget, no cross-talk
    // between two players behind the same NAT in the same lobby. Nick rotation
    // still gets a fresh playerId, but that requires a new lobby slot + bet.
    const _rk = ip + '#' + (socketInfo.playerId || 'x');
    if (!fairplay.checkInputWindow(_rk).ok) {
      penalize(ws, ip, socketInfo.nick, 'FLOOD', 'input-rate');
      sendErr(ws, 'Input rate exceeded');
      return;
    }
  } catch (e) {}
  // Validate inputs
  if (!validateInputs(inputs)) {
    penalize(ws, ip, socketInfo.nick, 'BAD_INPUT', 'inputs');
    sendErr(ws, 'Invalid inputs');
    return;
  }
  // Update lastSeen for the player (to prevent inactivity kick)
  lobby.updateLastSeen(socketInfo.playerId);
  // We'll store the inputs for the simulation tick
  // We'll keep a map of socketId to latest inputs
  if (!socketInfo.latestInputs) {
    socketInfo.latestInputs = {};
  }
  socketInfo.latestInputs = inputs;
}

function handleStart(ws, data, ip) {
  const socketInfo = getSocketInfo(ws);
  if (!socketInfo || !socketInfo.lobbyCode) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Not in a lobby' }));
    return;
  }
  const lobby = getLobby(socketInfo.lobbyCode);
  if (!lobby) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Lobby not found' }));
    return;
  }
  if (!lobby.hasQuorum()) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Need at least 2 players' }));
    return;
  }
  if (!lobby.allBetsPlaced()) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Waiting for all bets' }));
    return;
  }
  if (!lobby.startCountdown()) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Race already started' }));
    return;
  }
  broadcastLobbyState(lobby);
}

function handleLeave(ws, data, ip) {
  const socketInfo = getSocketInfo(ws);
  if (!socketInfo) {
    ws.send(JSON.stringify({ type: MSG_TYPE.ERROR, message: 'Not in a lobby' }));
    return;
  }
  handleDisconnect(socketInfo);
  // Remove socket info (keep the rate limiter so later messages still work)
  socketInfoMap.delete(ws);
  ws.send(JSON.stringify({
    type: MSG_TYPE.WELCOME,
    message: 'Left lobby'
  }));
}

function handleDisconnect(socketInfo) {
  if (!socketInfo) return;
  const lobby = getLobby(socketInfo.lobbyCode);
  if (!lobby) return;
  // Explicit leave: immediate removal. removePlayer already adds forfeit to lobby.forfeitedPool.
  const removeResult = lobby.removePlayer(socketInfo.playerId);
  if (removeResult.success) {
    console.log(`Player ${socketInfo.nick} left lobby ${socketInfo.lobbyCode}`);
    if (removeResult.betForfeited !== null) {
      console.log(`Player ${socketInfo.nick} forfeited bet of ${removeResult.betForfeited}`);
    }
  }
}

// Network drop: keep lobby slot 15s for HELLO+JOIN reconnect, then forfeit to pot.
function handleCloseDelayed(socketInfo) {
  if (!socketInfo || !socketInfo.lobbyCode) return;
  const lobby = getLobby(socketInfo.lobbyCode);
  if (!lobby) return;
  const player = lobby.players.find((pl) => pl.id === socketInfo.playerId);
  if (!player) return;
  player.disconnected = true;
  player.disconnectAt = Date.now();
  player.lastSeen = Date.now();
  const key = socketInfo.lobbyCode + '#' + socketInfo.nick;
  if (nickToDisconnectInfo.has(key)) {
    try { clearTimeout(nickToDisconnectInfo.get(key).timeoutId); } catch (e) {}
  }
  const timeoutId = setTimeout(() => {
    try {
      nickToDisconnectInfo.delete(key);
      const l = getLobby(socketInfo.lobbyCode);
      if (!l) return;
      const still = l.players.find((pl) => pl.nick === socketInfo.nick && pl.disconnected);
      if (still) {
        const r = l.removePlayer(still.id);
        if (r.success && r.betForfeited !== null) console.log('Player ' + socketInfo.nick + ' forfeited bet of ' + r.betForfeited + ' (reconnect timeout)');
      }
    } catch (e) {}
  }, RECONNECT_WINDOW_MS);
  nickToDisconnectInfo.set(key, { timeoutId, socketInfo: { lobbyCode: socketInfo.lobbyCode, playerId: socketInfo.playerId, nick: socketInfo.nick, ip: socketInfo.ip } });
}

// Periodic tasks
setInterval(() => {
  // 1. Update lobby states (countdown -> racing, etc.)
  for (const [code, lobby] of lobbies) {
    try {
      if (lobby.players.length === 0 && code !== DEFAULT_LOBBY_CODE) {
        lobbies.delete(code); // Prune empty lobbies (memory-leak guard)
        continue;
      }
    } catch (e) {}
    const newState = lobby.updateState();
    if (newState) {
      console.log(`Lobby ${code} state changed to: ${newState}`);
    }
    // 2. Remove inactive players
    const removed = lobby.removeInactivePlayers();
    removed.forEach(player => {
      console.log(`Player ${player.nick} removed from lobby ${code} due to inactivity`);
      // We already handled the bet forfeiture in removeInactivePlayers? 
      // In our lobby.removeInactivePlayers, we return the betForfeited but we don't do anything with it.
      // We'll need to add it to the pool. We'll do nothing for now.
    });
  }
  // 3. Simulate and broadcast for lobbies in racing state
  simulateAndBroadcast();
}, STEP * 1000); // 60Hz

function simulateAndBroadcast() {
  // We'll simulate at 60Hz and broadcast at 20Hz (every 3 ticks)
  // We'll keep a tick counter per lobby? Or we can do a global tick and broadcast when tick % 3 === 0.
  // We'll do a global tick counter.
  if (!simulateAndBroadcast.tick) {
    simulateAndBroadcast.tick = 0;
  }
  simulateAndBroadcast.tick++;
  const broadcastInterval = 3; // every 3 ticks -> 20Hz

  for (const [code, lobby] of lobbies) {
    if (lobby.state !== 'racing') continue;

    // Get latest inputs for each player in the lobby
    const playerInputs = new Map(); // playerId -> inputs
    const socketInfos = Array.from(socketInfoMap.values()).filter(info => info.lobbyCode === code);
    socketInfos.forEach(info => {
      if (info.latestInputs) {
        playerInputs.set(info.playerId, info.latestInputs);
      }
    });

    // Update each player's state (authoritative 60Hz)
    const LAPS_TO_WIN = 2;
    for (const player of lobby.players) {
      if (player.finished) continue;
      if (!player.carState) player.carState = createInitialState();
      const inputs = playerInputs.get(player.id) || { throttle: 0, brake: 0, steer: 0 };
      const prevState = player.carState;
      const ns = update(player.carState, inputs, STEP);
      try {
        const san = fairplay.physicsSanity(prevState, ns, STEP, { maxV: 200, maxDv: 5 });
        if (!san.ok) fairplay.fairplayLog({ ip: 'server', nick: 'sim', code: san.code || 'PHYS', detail: 'sim-invariant' });
      } catch (e) {}
      const gained = ns.v * STEP;
      player.carState = ns;
      player.totalProgress = (player.totalProgress || 0) + gained;
      if (player.totalProgress >= LAPS_TO_WIN * TRACK_LENGTH) {
        player.finished = true;
        lobby.finishCounter = (lobby.finishCounter || 0) + 1;
        player.finishOrder = lobby.finishCounter;
        if (lobby.finishCounter === 1) finishRace(lobby, player);
      }
    }

    // Broadcast state every broadcastInterval ticks
    if (simulateAndBroadcast.tick % broadcastInterval === 0) {
      broadcastLobbyState(lobby);
    }
  }
}

function finishRace(lobby, winner) {
  try {
    const bets = lobby.players.map(pl => pl.bet || 0);
    const forfeits = Math.round(lobby.forfeitedPool || 0);
    const wIdx = Math.max(0, lobby.players.findIndex(pl => pl.id === winner.id));
    // Quitter al pozo: forfeits se suman al total antes del 90/10.
    const effectiveBets = forfeits > 0 ? bets.concat([forfeits]) : bets;
    const { payouts, platformCut } = settle(effectiveBets, wIdx);
    lobby.lastResult = { winnerId: winner.id, winnerNick: winner.nick, payouts, platformCut, forfeitedPool: forfeits, finishedAt: Date.now() };
    lobby.state = 'finished';
    lobby.forfeitedPool = 0;
    broadcastLobbyState(lobby);
    // Pot integrity: payout encadenado en _betChain para no perder updates con bets concurrentes.
    _betChain = _betChain.then(() => creditWinner(lobby, wIdx, payouts)).catch((e) => console.error('payout chain failed:', e && e.message));
  } catch (e) { console.error('settle failed:', e.message); }
}

// Credits the race payout to the winner's stored balance. Runs inside _betChain
// so concurrent bets cannot cause lost updates. Never throws.
async function creditWinner(lobby, wIdx, payouts) {
  try {
    const prize = Math.round(payouts && typeof payouts[wIdx] === 'number' ? payouts[wIdx] : 0);
    if (!(prize > 0)) return;
    const champ = lobby.players[wIdx];
    if (!champ || !champ.nick || !champ.ip) return;
    const balances = await loadBalances();
    updateBalance(balances, champ.nick, champ.ip, prize);
    await saveBalances(balances);
  } catch (e) { console.error('creditWinner failed:', e && e.message); }
}

function broadcastLobbyState(lobby) {
  // We'll construct a state message
  const stateMsg = {
    type: MSG_TYPE.STATE,
    lobbyCode: lobby.code,
    state: lobby.state,
    players: lobby.players.map(pl => ({
      id: pl.id,
      nick: pl.nick,
      progress: pl.carState ? pl.carState.progress : 0,
      lap: pl.carState ? pl.carState.lap : 0,
      totalProgress: pl.totalProgress || 0,
      finished: !!pl.finished,
      v: pl.carState ? pl.carState.v : 0
    })),
    result: lobby.lastResult || null
  };
  const message = JSON.stringify(stateMsg);
  for (const [socket, info] of socketInfoMap.entries()) {
    if (info.lobbyCode === lobby.code && socket.readyState === WebSocket.OPEN) {
      try { socket.send(message); } catch (e) {}
    }
  }
}

// Handle server shutdown gracefully
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  WSS_SERVER.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { WSS_SERVER };