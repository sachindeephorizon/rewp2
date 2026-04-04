/**
 * ═══════════════════════════════════════════════════════════════════
 *  Server-side GPS filtering
 *  FIX 1: userStates now Redis-backed — survives server restarts.
 *  FIX 2: Removed accuracy*0.25 dynamic threshold — was classifying
 *          vehicle points as stationary (worse GPS = higher bar).
 * ═══════════════════════════════════════════════════════════════════
 */

const MAX_SPEED_MS = 80;          // ~290 km/h — covers all vehicle types
const STATIONARY_THRESHOLD = 4;   // meters — fixed, no accuracy multiplier
const MAX_JUMP_DIST = 200;        // meters — allow faster vehicle movement
const MAX_DT = 10;                // seconds — clamp time gap
const ACCURACY_THRESHOLD = 35;    // meters — match frontend MAX_ACCURACY

// ── 2D Kalman Filter ────────────────────────────────────────────────
class KalmanFilter2D {
  constructor() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.Q = 0.00001;
    this.R = 0.0001;
    this.stationaryCount = 0;
  }

  update(measurement, dt, accuracy, isStationary = false) {
    if (!this.x) {
      this.x = [...measurement];
      return this.x;
    }

    if (isStationary) {
      this.stationaryCount++;
      if (this.stationaryCount >= 3) {
        this.v = [0, 0];
      } else {
        this.v = [this.v[0] * 0.2, this.v[1] * 0.2];
      }
    } else {
      this.stationaryCount = 0;
    }

    const predicted = [
      this.x[0] + this.v[0] * dt,
      this.x[1] + this.v[1] * dt,
    ];
    const predictedP = this.P + this.Q;
    const adaptiveR = this.R * Math.max(1, accuracy / 5);
    const K = predictedP / (predictedP + adaptiveR);

    this.x = [
      predicted[0] + K * (measurement[0] - predicted[0]),
      predicted[1] + K * (measurement[1] - predicted[1]),
    ];

    if (dt > 0 && !isStationary) {
      this.v = [
        (this.x[0] - predicted[0] + this.v[0] * dt) / dt,
        (this.x[1] - predicted[1] + this.v[1] * dt) / dt,
      ];
    }

    this.P = (1 - K) * predictedP;
    return this.x;
  }

  reset() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.stationaryCount = 0;
  }

  // Serialize to plain object for Redis storage
  toJSON() {
    return { x: this.x, v: this.v, P: this.P, Q: this.Q, R: this.R, stationaryCount: this.stationaryCount };
  }

  // Restore from plain object
  fromJSON(data) {
    if (!data) return;
    this.x = data.x ?? null;
    this.v = data.v ?? [0, 0];
    this.P = data.P ?? 1;
    this.Q = data.Q ?? 0.00001;
    this.R = data.R ?? 0.0001;
    this.stationaryCount = data.stationaryCount ?? 0;
  }
}

// ── Haversine Distance ──────────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Process Location ────────────────────────────────────────────────
function processLocation(newLat, newLng, prevEntry, kalman, accuracy = null, timestamp = null) {
  if (
    typeof newLat !== "number" || typeof newLng !== "number" ||
    newLat < -90 || newLat > 90 || newLng < -180 || newLng > 180
  ) return null;

  const normalizedAccuracy =
    typeof accuracy === "number" && isFinite(accuracy) ? accuracy : ACCURACY_THRESHOLD;

  if (normalizedAccuracy <= 0 || normalizedAccuracy > ACCURACY_THRESHOLD) return null;

  const now = timestamp || Date.now();

  if (!prevEntry) {
    const filtered = kalman.update([newLat, newLng], 1, normalizedAccuracy);
    return { latitude: filtered[0], longitude: filtered[1], timestamp: now };
  }

  const dt = Math.min((now - prevEntry.timestamp) / 1000, MAX_DT);
  if (dt <= 0) return null;

  const rawDist = haversineDistance(prevEntry.latitude, prevEntry.longitude, newLat, newLng);
  if (rawDist > MAX_JUMP_DIST) return null;

  const rawSpeed = rawDist / dt;
  if (rawSpeed > MAX_SPEED_MS) return null;

  // FIX 2: Fixed threshold — no accuracy multiplier.
  // Old: accuracy*0.25 → worse GPS in vehicles = higher bar = stationary misclassification.
  const isStationary = rawDist < STATIONARY_THRESHOLD;

  if (isStationary) {
    kalman.update([prevEntry.latitude, prevEntry.longitude], dt, normalizedAccuracy, true);
    return { ...prevEntry, timestamp: now };
  }

  const filtered = kalman.update([newLat, newLng], dt, normalizedAccuracy, false);
  const filteredDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    filtered[0], filtered[1]
  );

  if (filteredDist / dt > MAX_SPEED_MS) return null;

  return { latitude: filtered[0], longitude: filtered[1], timestamp: now };
}

// ── Per-user state cache — Redis-backed ─────────────────────────────
// FIX 1: Old Map() was wiped on every Railway restart → triggered isFirstPing
// → cleared Redis session → "no active session" on dashboard.
// Now state is persisted in Redis and restored on next ping after restart.

let _redis = null;

function initGpsState(redisClient) {
  _redis = redisClient;
}

// In-memory cache to avoid Redis round-trip on every ping
const memCache = new Map();

async function getUserState(userId) {
  // Return from memory cache if available
  if (memCache.has(userId)) return memCache.get(userId);

  // Try to restore from Redis after a server restart
  const stateKey = `gpsstate:${userId}`;
  try {
    const raw = _redis ? await _redis.get(stateKey) : null;
    if (raw) {
      const saved = JSON.parse(raw);
      const kalman = new KalmanFilter2D();
      kalman.fromJSON(saved.kalman);
      const state = {
        prev: saved.prev || null,
        kalman,
      };
      memCache.set(userId, state);
      console.log(`[gps] Restored state for ${userId} from Redis after restart`);
      return state;
    }
  } catch (e) {
    console.error("[gps] Failed to restore state from Redis:", e.message);
  }

  // Fresh state
  const state = { prev: null, kalman: new KalmanFilter2D() };
  memCache.set(userId, state);
  return state;
}

// Call after every processLocation to persist state to Redis
async function saveUserState(userId) {
  const state = memCache.get(userId);
  if (!state || !_redis) return;
  const stateKey = `gpsstate:${userId}`;
  try {
    await _redis.setEx(stateKey, 86400, JSON.stringify({
      prev: state.prev,
      kalman: state.kalman.toJSON(),
    }));
  } catch (e) {
    console.error("[gps] Failed to save state to Redis:", e.message);
  }
}

function clearUserState(userId) {
  memCache.delete(userId);
  if (_redis) {
    const stateKey = `gpsstate:${userId}`;
    _redis.del(stateKey).catch(() => {});
  }
}

module.exports = {
  processLocation,
  getUserState,
  saveUserState,
  clearUserState,
  initGpsState,
  haversineDistance,
  KalmanFilter2D,
};