/**
 * ═══════════════════════════════════════════════════════════════════
 *  Server-side GPS filtering — production ready
 *
 *  Key fixes:
 *  1. Redis-backed userStates — survives server restarts
 *  2. Gap detection — if > GAP_RESET_SECONDS since last ping,
 *     treat next point as fresh (no filtering, no impossible speed)
 *  3. Filter streak reset — breaks permanent filter loops
 *  4. Fixed thresholds — no accuracy multiplier nonsense
 * ═══════════════════════════════════════════════════════════════════
 */

const MAX_SPEED_MS = 80;          // ~290 km/h
const STATIONARY_THRESHOLD = 4;   // meters
const MAX_JUMP_DIST = 300;        // meters
const MAX_DT = 60;                // seconds — covers Doze gaps
const ACCURACY_THRESHOLD = 35;    // meters
const MAX_FILTER_STREAK = 3;      // reset after 3 consecutive filtered points
const GAP_RESET_SECONDS = 60;     // if gap > 60s, treat as fresh start

// ── 2D Kalman Filter ────────────────────────────────────────────────
class KalmanFilter2D {
  constructor() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    // FIX: Q increased 0.00001 → 0.0001 (trust GPS measurement more,
    // prediction less). Old value made filter over-trust velocity prediction
    // on curves → points cut corners instead of following the road.
    this.Q = 0.0001;
    // FIX: R increased 0.0001 → 0.001 (allow more correction toward
    // actual GPS reading). Combined with higher Q, filter now follows
    // real movement more closely instead of smoothing over turns.
    this.R = 0.001;
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

  toJSON() {
    return {
      x: this.x, v: this.v, P: this.P,
      Q: this.Q, R: this.R,
      stationaryCount: this.stationaryCount,
    };
  }

  fromJSON(data) {
    if (!data) return;
    this.x = data.x ?? null;
    this.v = data.v ?? [0, 0];
    this.P = data.P ?? 1;
    this.Q = data.Q ?? 0.0001;
    this.R = data.R ?? 0.001;
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
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Process Location ────────────────────────────────────────────────
function processLocation(newLat, newLng, prevEntry, kalman, accuracy = null, timestamp = null) {
  if (
    typeof newLat !== 'number' || typeof newLng !== 'number' ||
    newLat < -90 || newLat > 90 || newLng < -180 || newLng > 180
  ) return null;

  const normalizedAccuracy =
    typeof accuracy === 'number' && isFinite(accuracy)
      ? accuracy
      : ACCURACY_THRESHOLD;

  if (normalizedAccuracy <= 0 || normalizedAccuracy > ACCURACY_THRESHOLD) return null;

  const now = timestamp || Date.now();

  // No previous point — always accept as first reading
  if (!prevEntry) {
    const filtered = kalman.update([newLat, newLng], 1, normalizedAccuracy);
    return { latitude: filtered[0], longitude: filtered[1], timestamp: now };
  }

  const gapSeconds = (now - prevEntry.timestamp) / 1000;

  // GAP DETECTION: if too much time has passed since last ping
  // (screen off, Doze, server restart, background gap), treat as
  // fresh start — never filter based on distance/speed across a gap.
  if (gapSeconds > GAP_RESET_SECONDS) {
    console.log(
      `[gps] Gap detected: ${gapSeconds.toFixed(0)}s — accepting as fresh start`
    );
    kalman.reset();
    const filtered = kalman.update([newLat, newLng], 1, normalizedAccuracy);
    return { latitude: filtered[0], longitude: filtered[1], timestamp: now };
  }

  const dt = Math.min(gapSeconds, MAX_DT);
  if (dt <= 0) return null;

  const rawDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    newLat, newLng
  );

  if (rawDist > MAX_JUMP_DIST) return null;

  const rawSpeed = rawDist / dt;
  if (rawSpeed > MAX_SPEED_MS) return null;

  const isStationary = rawDist < STATIONARY_THRESHOLD;

  if (isStationary) {
    kalman.update([prevEntry.latitude, prevEntry.longitude], dt, normalizedAccuracy, true);
    return {
      latitude: prevEntry.latitude,
      longitude: prevEntry.longitude,
      timestamp: now,
    };
  }

  const filtered = kalman.update([newLat, newLng], dt, normalizedAccuracy, false);
  const filteredDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    filtered[0], filtered[1]
  );

  if (filteredDist / dt > MAX_SPEED_MS) return null;

  return { latitude: filtered[0], longitude: filtered[1], timestamp: now };
}

// ── Per-user state — Redis-backed ───────────────────────────────────
let _redis = null;
const memCache = new Map();

function initGpsState(redisClient) {
  _redis = redisClient;
}

async function getUserState(userId) {
  if (memCache.has(userId)) return memCache.get(userId);

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
        filterStreak: saved.filterStreak || 0,
      };
      memCache.set(userId, state);
      console.log(`[gps] Restored state for ${userId} from Redis`);
      return state;
    }
  } catch (e) {
    console.error('[gps] Failed to restore state:', e.message);
  }

  const state = { prev: null, kalman: new KalmanFilter2D(), filterStreak: 0 };
  memCache.set(userId, state);
  return state;
}

async function saveUserState(userId) {
  const state = memCache.get(userId);
  if (!state || !_redis) return;
  try {
    await _redis.setEx(`gpsstate:${userId}`, 86400, JSON.stringify({
      prev: state.prev,
      kalman: state.kalman.toJSON(),
      filterStreak: state.filterStreak,
    }));
  } catch (e) {
    console.error('[gps] Failed to save state:', e.message);
  }
}

function clearUserState(userId) {
  memCache.delete(userId);
  if (_redis) _redis.del(`gpsstate:${userId}`).catch(() => {});
}

module.exports = {
  processLocation,
  getUserState,
  saveUserState,
  clearUserState,
  initGpsState,
  haversineDistance,
  KalmanFilter2D,
  MAX_FILTER_STREAK,
  GAP_RESET_SECONDS,
};