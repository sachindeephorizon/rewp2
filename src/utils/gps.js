/**
 * ═══════════════════════════════════════════════════════════════════
 *  Server-side GPS filtering — smooths noisy coordinates.
 * ═══════════════════════════════════════════════════════════════════
 *
 * Per-user state so each user has isolated smoothing (no cross-talk).
 */

const MAX_SPEED_MS = 50;          // ~180 km/h — reject anything faster
const STATIONARY_THRESHOLD = 5;   // meters — ignore drift below this
const MAX_JUMP_DIST = 100;        // meters — reject teleports
const MAX_DT = 5;                 // seconds — clamp time gap
const ACCURACY_THRESHOLD = 20;    // meters — reject GPS >20m accuracy

// ── 2D Kalman Filter ────────────────────────────────────────────────
class KalmanFilter2D {
  constructor() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.Q = 0.01;
    this.R = 0.0001;
    this.stationaryCount = 0;
  }

  update(measurement, dt, isStationary = false) {
    if (!this.x) {
      this.x = measurement;
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

    this.x = [
      this.x[0] + this.v[0] * dt,
      this.x[1] + this.v[1] * dt,
    ];

    const K = this.P / (this.P + this.R);

    this.x = [
      this.x[0] + K * (measurement[0] - this.x[0]),
      this.x[1] + K * (measurement[1] - this.x[1]),
    ];

    if (dt > 0 && !isStationary) {
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
    this.stationaryCount = 0;
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
function processLocation(newLat, newLng, prevEntry, kalman, accuracy = null, timestamp = null, userState = null) {
  if (typeof newLat !== 'number' || typeof newLng !== 'number' ||
      newLat < -90 || newLat > 90 || newLng < -180 || newLng > 180) {
    return null;
  }

  if (accuracy !== null && accuracy > ACCURACY_THRESHOLD) {
    return null;
  }

  const now = timestamp || Date.now();

  if (!prevEntry) {
    const filtered = kalman.update([newLat, newLng], 1);
    const initialLocation = {
      latitude: filtered[0],
      longitude: filtered[1],
      timestamp: now,
    };

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

  // Scale stationary threshold by accuracy — worse GPS = higher bar
  const dynamicThreshold = accuracy !== null
    ? Math.max(STATIONARY_THRESHOLD, accuracy * 0.8)
    : STATIONARY_THRESHOLD;
  const isStationary = rawDist < dynamicThreshold;

  if (isStationary) {
    kalman.update([prevEntry.latitude, prevEntry.longitude], dt, true);
    return { ...prevEntry, timestamp: now };
  }

  const filtered = kalman.update([newLat, newLng], dt, false);
  let filteredLat = filtered[0];
  let filteredLng = filtered[1];

  // Multi-point smoothing — sliding window average after Kalman
  if (userState && userState.window) {
    userState.window.push(filteredLat, filteredLng);
    const avg = userState.window.average();
    filteredLat = avg.lat;
    filteredLng = avg.lng;
  }

  const filteredDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    filteredLat, filteredLng
  );

  if (filteredDist < dynamicThreshold) {
    return { ...prevEntry, timestamp: now };
  }

  let finalLat = filteredLat;
  let finalLng = filteredLng;
  const smoothedLocation = userState ? userState.smoothedLocation : null;

  if (smoothedLocation) {
    const weight = 0.3;
    finalLat = smoothedLocation.latitude * (1 - weight) + filteredLat * weight;
    finalLng = smoothedLocation.longitude * (1 - weight) + filteredLng * weight;
  }

  if (userState) {
    userState.smoothedLocation = { latitude: finalLat, longitude: finalLng };
  }

  const previousLocation = userState ? userState.previousLocation : null;
  const moveDist = previousLocation ?
    haversineDistance(previousLocation.latitude, previousLocation.longitude, finalLat, finalLng) :
    filteredDist;

  const computedSpeed = moveDist / dt;
  if (computedSpeed > MAX_SPEED_MS) return null;

  if (userState) {
    userState.previousLocation = { latitude: finalLat, longitude: finalLng };
    userState.previousTimestamp = now;
  }

  return {
    latitude: finalLat,
    longitude: finalLng,
    timestamp: now,
  };
}

// ── Sliding Window for multi-point smoothing ───────────────────────
class SlidingWindow {
  constructor(size = 5) {
    this.size = size;
    this.buffer = [];
  }

  push(lat, lng) {
    this.buffer.push({ lat, lng });
    if (this.buffer.length > this.size) this.buffer.shift();
  }

  average() {
    const len = this.buffer.length;
    if (len === 0) return null;
    if (len === 1) return { lat: this.buffer[0].lat, lng: this.buffer[0].lng };

    let totalWeight = 0;
    let latSum = 0;
    let lngSum = 0;
    for (let i = 0; i < len; i++) {
      const weight = i + 1;
      latSum += this.buffer[i].lat * weight;
      lngSum += this.buffer[i].lng * weight;
      totalWeight += weight;
    }
    return { lat: latSum / totalWeight, lng: lngSum / totalWeight };
  }

  reset() {
    this.buffer = [];
  }
}

// ── Per-user state cache ────────────────────────────────────────────
const userStates = new Map();

function getUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      prev: null,
      kalman: new KalmanFilter2D(),
      window: new SlidingWindow(),
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
