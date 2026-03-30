/**
 * ═══════════════════════════════════════════════════════════════════
 *  Server-side GPS filtering — mirrors frontend logic exactly.
 * ═══════════════════════════════════════════════════════════════════
 *
 * FIX: Removed 3 global variables (previousLocation, previousTimestamp,
 * smoothedLocation) that were shared across ALL users. When User A sent
 * a ping it overwrote the smoothing state for User B, corrupting GPS
 * output for every user except the last one to ping.
 * These are now stored per-user inside getUserState().
 */

const MAX_SPEED_MS = 50;          // ~180 km/h — reject anything faster
const STATIONARY_THRESHOLD = 3;   // meters — ignore drift below this
const MAX_JUMP_DIST = 100;        // meters — reject teleports
const MAX_DT = 5;                 // seconds — clamp time gap
const ACCURACY_THRESHOLD = 30;    // meters — reject GPS >30m accuracy

// Adaptive accuracy based on speed
const getAdaptiveAccuracyThreshold = (speed) => {
  if (speed < 2) return 20;
  if (speed < 10) return 30;
  if (speed < 30) return 50;
  return 100;
};

// Activity detection based on speed
const detectActivity = (speed, prevSpeed = 0) => {
  if (speed < 0.5) return 'stationary';
  if (speed < 3) return 'walking';
  if (speed < 15) return 'cycling';
  if (speed < 40) return 'driving';
  return 'high_speed';
};

// ── 2D Kalman Filter ────────────────────────────────────────────────
class KalmanFilter2D {
  constructor() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.Q = 0.01;
    this.R = 0.0001;
  }

  update(measurement, dt) {
    if (!this.x) {
      this.x = measurement;
      return this.x;
    }

    this.x = [
      this.x[0] + this.v[0] * dt,
      this.x[1] + this.v[1] * dt,
    ];

    const K = this.P / (this.P + this.R);

    this.x = [
      this.x[0] + K * (measurement[0] - this.x[0]),
      this.x[1] + K * (measurement[1] - this.x[1]),
    ];

    if (dt > 0) {
      this.v = [
        (measurement[0] - this.x[0]) / dt,
        (measurement[1] - this.x[1]) / dt,
      ];
    }

    this.P = (1 - K) * this.P + this.Q;

    return this.x;
  }

  reset() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
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
// FIX: smoothedLocation and previousLocation are now passed in as part
// of userState (per-user) instead of being global variables shared
// across all users. Each user has their own isolated smoothing state.
function processLocation(newLat, newLng, speed, prevEntry, kalman, accuracy = null, timestamp = null, userId = null, userState = null) {
  if (typeof newLat !== 'number' || typeof newLng !== 'number' ||
      newLat < -90 || newLat > 90 || newLng < -180 || newLng > 180) {
    return null;
  }

  // Adaptive accuracy threshold based on previous speed
  let adaptiveAccuracyThreshold = ACCURACY_THRESHOLD;
  if (prevEntry && prevEntry.speed !== undefined) {
    adaptiveAccuracyThreshold = getAdaptiveAccuracyThreshold(prevEntry.speed);
  }

  if (accuracy !== null && accuracy > adaptiveAccuracyThreshold) {
    return null;
  }

  const now = timestamp || Date.now();

  if (!prevEntry) {
    const filtered = kalman.update([newLat, newLng], 1);
    const initialLocation = {
      latitude: filtered[0],
      longitude: filtered[1],
      speed: 0,
      timestamp: now,
      activity: 'stationary',
    };

    // FIX: Store in per-user state, not globals
    if (userState) {
      userState.smoothedLocation = { latitude: newLat, longitude: newLng };
      userState.previousLocation = { latitude: newLat, longitude: newLng };
      userState.previousTimestamp = now;
    }

    return initialLocation;
  }

  const dt = Math.min((now - prevEntry.timestamp) / 1000, MAX_DT);
  if (dt <= 0) return null;

  const rawDist = haversineDistance(prevEntry.latitude, prevEntry.longitude, newLat, newLng);
  if (rawDist > MAX_JUMP_DIST) return null;

  const teleportSpeed = rawDist / dt;
  if (teleportSpeed > MAX_SPEED_MS) return null;

  const filtered = kalman.update([newLat, newLng], dt);
  const filteredLat = filtered[0];
  const filteredLng = filtered[1];

  const filteredDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    filteredLat, filteredLng
  );

  if (filteredDist < STATIONARY_THRESHOLD) {
    return { ...prevEntry, speed: 0, timestamp: now, activity: 'stationary' };
  }

  // FIX: Use per-user smoothedLocation instead of global
  let finalLat = filteredLat;
  let finalLng = filteredLng;
  const smoothedLocation = userState ? userState.smoothedLocation : null;

  if (smoothedLocation) {
    const weight = 0.3;
    finalLat = smoothedLocation.latitude * (1 - weight) + filteredLat * weight;
    finalLng = smoothedLocation.longitude * (1 - weight) + filteredLng * weight;
  }

  // FIX: Update per-user smoothed location
  if (userState) {
    userState.smoothedLocation = { latitude: finalLat, longitude: finalLng };
  }

  // FIX: Use per-user previousLocation instead of global
  const previousLocation = userState ? userState.previousLocation : null;
  const speedDist = previousLocation ?
    haversineDistance(previousLocation.latitude, previousLocation.longitude, finalLat, finalLng) :
    filteredDist;

  let computedSpeed = speedDist / dt;

  if (computedSpeed > MAX_SPEED_MS) return null;
  if (speedDist < STATIONARY_THRESHOLD) computedSpeed = 0;
  if (computedSpeed < 0.1) computedSpeed = 0;

  const activity = detectActivity(computedSpeed, prevEntry.speed);

  // FIX: Update per-user previous location
  if (userState) {
    userState.previousLocation = { latitude: finalLat, longitude: finalLng };
    userState.previousTimestamp = now;
  }

  return {
    latitude: finalLat,
    longitude: finalLng,
    speed: computedSpeed,
    timestamp: now,
    activity,
  };
}

// ── Per-user state cache ────────────────────────────────────────────
// FIX: Added smoothedLocation, previousLocation, previousTimestamp
// to per-user state so they are never shared between users.
const userStates = new Map();

function getUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      prev: null,
      kalman: new KalmanFilter2D(),
      activity: 'unknown',
      speedHistory: [],
      // FIX: these were global before — now isolated per user
      smoothedLocation: null,
      previousLocation: null,
      previousTimestamp: null,
    });
  }
  return userStates.get(userId);
}

function clearUserState(userId) {
  userStates.delete(userId);
}

module.exports = {
  processLocation,
  getUserState,
  clearUserState,
  haversineDistance,
  KalmanFilter2D,
};