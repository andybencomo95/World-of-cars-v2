// Protocol definitions and validation for World of Cars online racing
// Pure validation logic, no WebSocket dependencies

/**
 * Validates a lobby code: 4 uppercase letters from A-Z excluding O, I (to avoid confusion with 0 and 1)
 * @param {string} code
 * @returns {boolean}
 */
function validateLobbyCode(code) {
  if (typeof code !== 'string' || code.length !== 4) return false;
  // Ambiguous characters: O, I (and also 0 and 1 but we are only using letters)
  const ambiguous = new Set(['O', 'I']);
  for (let i = 0; i < 4; i++) {
    const c = code[i];
    if (c < 'A' || c > 'Z') return false;
    if (ambiguous.has(c)) return false;
  }
  return true;
}

/**
 * Validates a nickname: non-empty string, max length 20, alphanumeric and underscore only
 * @param {string} nick
 * @returns {boolean}
 */
function validateNick(nick) {
  if (typeof nick !== 'string' || nick.length === 0 || nick.length > 20) return false;
  // Allow alphanumeric and underscore
  return /^[a-zA-Z0-9_]+$/.test(nick);
}

/**
 * Validates a bet amount: integer >= 1
 * @param {number} bet
 * @returns {boolean}
 */
function validateBet(bet) {
  return Number.isInteger(bet) && bet >= 1;
}

/**
 * Validates input object: throttle, brake, steer each between 0 and 1 (or -1 to 1 for steer)
 * @param {{throttle:number, brake:number, steer:number}} inputs
 * @returns {boolean}
 */
function validateInputs(inputs) {
  if (typeof inputs !== 'object' || inputs === null) return false;
  const { throttle, brake, steer } = inputs;
  if (typeof throttle !== 'number' || !Number.isFinite(throttle) || throttle < 0 || throttle > 1) return false;
  if (typeof brake !== 'number' || !Number.isFinite(brake) || brake < 0 || brake > 1) return false;
  if (typeof steer !== 'number' || !Number.isFinite(steer) || steer < -1 || steer > 1) return false;
  return true;
}

/**
 * Validates rate: maximum 30 messages per second per connection
 * This is a stateful validator that should be used per connection.
 * We return a function that can be called to check if a message is allowed.
 * @returns {function(): boolean} a function that returns true if the message is allowed, false otherwise
 */
function createRateLimiter(maxPerSecond = 30) {
  const minInterval = 1000 / maxPerSecond; // milliseconds
  let lastTimestamp = 0;
  return function () {
    const now = Date.now();
    if (now - lastTimestamp >= minInterval) {
      lastTimestamp = now;
      return true;
    }
    return false;
  };
}

// Max raw message size in bytes (pre-parse guard; must match server maxPayload)
const MAX_MESSAGE_BYTES = 4096;
/**
 * Pre-parse envelope guard. Never throws.
 * @param {string|Buffer} raw
 * @returns {{valid:boolean, error?:string}}
 */
function validateEnvelope(raw) {
  try {
    let len = -1;
    if (typeof raw === 'string') len = Buffer.byteLength(raw, 'utf8');
    else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) len = raw.length;
    else if (raw != null && typeof raw.byteLength === 'number') len = raw.byteLength;
    if (len < 0) return { valid: false, error: 'Bad envelope' };
    if (len === 0) return { valid: false, error: 'Empty message' };
    if (len > MAX_MESSAGE_BYTES) return { valid: false, error: 'Message too large' };
    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'Bad envelope' };
  }
}
// Message types (as strings)
const MSG_TYPE = {
  HELLO: 'hello',
  CREATE: 'create',
  JOIN: 'join',
  BET: 'bet',
  INPUT: 'input',
  START: 'start',
  LEAVE: 'leave',
  STATE: 'state',
  WELCOME: 'welcome',
  ERROR: 'error'
};

// We'll also define the structure of each message for validation
const MESSAGE_SCHEMAS = {
  [MSG_TYPE.HELLO]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.HELLO] },
      nick: { type: 'string' }
    },
    required: ['type', 'nick'],
    additionalProperties: false
  },
  [MSG_TYPE.CREATE]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.CREATE] }
    },
    required: ['type'],
    additionalProperties: false
  },
  [MSG_TYPE.JOIN]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.JOIN] },
      code: { type: 'string' }
    },
    required: ['type', 'code'],
    additionalProperties: false
  },
  [MSG_TYPE.BET]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.BET] },
      amount: { type: 'number' }
    },
    required: ['type', 'amount'],
    additionalProperties: false
  },
  [MSG_TYPE.INPUT]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.INPUT] },
      inputs: {
        type: 'object',
        properties: {
          throttle: { type: 'number', minimum: 0, maximum: 1 },
          brake: { type: 'number', minimum: 0, maximum: 1 },
          steer: { type: 'number', minimum: -1, maximum: 1 }
        },
        required: ['throttle', 'brake', 'steer'],
        additionalProperties: false
      }
    },
    required: ['type', 'inputs'],
    additionalProperties: false
  },
  [MSG_TYPE.START]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.START] }
    },
    required: ['type'],
    additionalProperties: false
  },
  [MSG_TYPE.LEAVE]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.LEAVE] }
    },
    required: ['type'],
    additionalProperties: false
  },
  [MSG_TYPE.STATE]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.STATE] },
      lobbyCode: { type: 'string' },
      state: { type: 'string' },
      players: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            nick: { type: 'string' },
            progress: { type: 'number' },
            lap: { type: 'number' }
          },
          required: ['id', 'nick', 'progress', 'lap'],
          additionalProperties: false
        }
      }
    },
    required: ['type', 'lobbyCode', 'state', 'players'],
    additionalProperties: false
  },
  [MSG_TYPE.WELCOME]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.WELCOME] },
      message: { type: 'string' },
      defaultLobbyCode: { type: 'string' }
    },
    required: ['type', 'message', 'defaultLobbyCode'],
    additionalProperties: false
  },
  [MSG_TYPE.ERROR]: {
    type: 'object',
    properties: {
      type: { enum: [MSG_TYPE.ERROR] },
      message: { type: 'string' }
    },
    required: ['type', 'message'],
    additionalProperties: false
  }
};

/**
 * Validates a message against its schema
 * @param {any} message
 * @returns {{valid: boolean, error?: string}}
 */
function validateMessage(message) {
  if (typeof message !== 'object' || message === null) {
    return { valid: false, error: 'Message must be an object' };
  }
  const { type } = message;
  if (typeof type !== 'string') {
    return { valid: false, error: 'Message must have a type string' };
  }
  const schema = MESSAGE_SCHEMAS[type];
  if (!schema) {
    return { valid: false, error: `Unknown message type: ${type}` };
  }
  // Simple validation (for now we do a basic check, but we could use a library like ajv)
  // We'll do a manual check for required properties and types.
  switch (type) {
    case MSG_TYPE.HELLO:
      if (typeof message.nick !== 'string') {
        return { valid: false, error: 'nick must be a string' };
      }
      if (!validateNick(message.nick)) {
        return { valid: false, error: 'Invalid nick' };
      }
      break;
    case MSG_TYPE.CREATE:
      // No additional fields
      break;
    case MSG_TYPE.JOIN:
      if (typeof message.code !== 'string') {
        return { valid: false, error: 'code must be a string' };
      }
      if (!validateLobbyCode(message.code)) {
        return { valid: false, error: 'Invalid lobby code' };
      }
      break;
    case MSG_TYPE.BET:
      if (typeof message.amount !== 'number') {
        return { valid: false, error: 'amount must be a number' };
      }
      if (!validateBet(message.amount)) {
        return { valid: false, error: 'Bet must be an integer >= 1' };
      }
      break;
    case MSG_TYPE.INPUT: {
      const inp = message.inputs || (('throttle' in message || 'brake' in message || 'steer' in message) ? { throttle: message.throttle, brake: message.brake, steer: message.steer } : null);
      if (typeof inp !== 'object' || inp === null) {
        return { valid: false, error: 'inputs must be an object' };
      }
      if (!validateInputs(inp)) {
        return { valid: false, error: 'Invalid inputs' };
      }
      break;
    }
    case MSG_TYPE.START:
      break;
    case MSG_TYPE.LEAVE:
      // No additional fields
      break;
    case MSG_TYPE.STATE:
      // This is generated by the server, so we assume it's valid
      // But we could validate if needed
      break;
    case MSG_TYPE.WELCOME:
      if (typeof message.message !== 'string') {
        return { valid: false, error: 'message must be a string' };
      }
      if (typeof message.defaultLobbyCode !== 'string') {
        return { valid: false, error: 'defaultLobbyCode must be a string' };
      }
      break;
    case MSG_TYPE.ERROR:
      if (typeof message.message !== 'string') {
        return { valid: false, error: 'message must be a string' };
      }
      break;
    default:
      return { valid: false, error: `Unhandled message type: ${type}` };
  }
  return { valid: true };
}

module.exports = {
  validateLobbyCode,
  validateNick,
  validateBet,
  validateInputs,
  createRateLimiter,
  MSG_TYPE,
  validateMessage,
  MAX_MESSAGE_BYTES,
  validateEnvelope
};