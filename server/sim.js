// Deterministic physics simulation for online racing
// Pure function, no DOM, no audio, no random per frame

const STEP = 1 / 60; // fixed time step
const TRACK_LENGTH = 1000; // arbitrary track length for progress/lap
const MAX_ACCELERATION = 10; // m/s^2
const MAX_DECELERATION = 15; // m/s^2
const STEER_RATE = Math.PI / 2; // rad/s
const MAX_SPEED = 100; // m/s, optional but good for stability

/**
 * Creates initial car state
 * @returns {{x:number, y:number, angle:number, v:number, progress:number, lap:number}}
 */
function createInitialState() {
  return {
    x: 0,
    y: 0,
    angle: 0,
    v: 0,
    progress: 0,
    lap: 0
  };
}

/**
 * Updates car state based on inputs and time step
 * @param {{x:number, y:number, angle:number, v:number, progress:number, lap:number}} state
 * @param {{throttle:number, brake:number, steer:number}} inputs - throttle: 0-1, brake: 0-1, steer: -1-1
 * @param {number} dt - time step (should be STEP for fixed updates)
 * @returns {{x:number, y:number, angle:number, v:number, progress:number, lap:number}} new state
 */
function update(state, inputs, dt) {
  // Clone state to avoid mutation (pure function)
  const newState = { ...state };

  // Input validation and clamping
  const throttle = Math.max(0, Math.min(1, inputs.throttle));
  const brake = Math.max(0, Math.min(1, inputs.brake));
  const steer = Math.max(-1, Math.min(1, inputs.steer));

  // Calculate acceleration
  const acceleration = throttle * MAX_ACCELERATION - brake * MAX_DECELERATION;

  // Update velocity
  let newV = state.v + acceleration * dt;
  // Clamp velocity to [-MAX_SPEED, MAX_SPEED]? Actually, we don't want negative speed? 
  // But for simplicity, we allow reverse? The spec doesn't say. Let's assume forward only.
  // We'll clamp to 0 and MAX_SPEED for simplicity in this slice.
  if (newV < 0) newV = 0;
  if (newV > MAX_SPEED) newV = MAX_SPEED;
  newState.v = newV;

  // Update angle (steering)
  newState.angle = state.angle + steer * STEER_RATE * dt;
  // Keep angle in reasonable range (optional, but helps with determinism)
  newState.angle = ((newState.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  // Update position
  newState.x = state.x + newV * Math.cos(newState.angle) * dt;
  newState.y = state.y + newV * Math.sin(newState.angle) * dt;

  // Update progress and lap
  const distanceThisFrame = newV * dt; // distance traveled in this frame
  newState.progress = state.progress + distanceThisFrame;
  // Calculate laps and residual progress
  const laps = Math.floor(newState.progress / TRACK_LENGTH);
  newState.lap = state.lap + laps;
  newState.progress = newState.progress - laps * TRACK_LENGTH;

  return newState;
}

module.exports = {
  STEP,
  TRACK_LENGTH,
  MAX_ACCELERATION,
  MAX_DECELERATION,
  STEER_RATE,
  MAX_SPEED,
  createInitialState,
  update
};