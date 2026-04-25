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

import type { ProcessedLocation, KalmanState, GpsUserState } from "../types";
import type { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

const MAX_SPEED_MS = 80;          // ~290 km/h
const STATIONARY_THRESHOLD = 4;   // meters
const MAX_JUMP_DIST = 300;        // meters — floor for short ping gaps
const MAX_JUMP_SPEED_MS = 30;     // ~108 km/h — scales jump tolerance with dt
const MAX_DT = 60;                // seconds — covers Doze gaps
// Strict accuracy gate. Cell-tower-only fixes (Accuracy.Lowest on the
// client) report accuracy values of 500–3000 m and get rejected here —
// that's intentional. The client takes ONE good Balanced-accuracy seed
// fix at session start (~10 m), which passes this gate and populates
// /users/active. After that, only legitimate fixes (T2/T3 GPS, or T1
// fixes that happen to be WiFi-assisted under 35 m) update Redis. The
// trail stays clean even when the user is stationary; cell-tower
// jitter no longer pollutes /sessions/*/logs.
const ACCURACY_THRESHOLD = 35;
export const MAX_FILTER_STREAK = 3;      // reset after 3 consecutive filtered points
export const GAP_RESET_SECONDS = 60;     // if gap > 60s, treat as fresh start

export type GpsFilterReason =
  | 'invalid_coordinates'
  | 'invalid_accuracy'
  | 'accuracy_too_low_precision'
  | 'non_positive_dt'
  | 'jump_too_large'
  | 'raw_speed_too_high'
  | 'filtered_speed_too_high';

export interface ProcessLocationResult {
  location: ProcessedLocation | null;
  reason: GpsFilterReason | null;
}

// ── 2D Kalman Filter ────────────────────────────────────────────────
export class KalmanFilter2D {
  x: number[] | null;
  v: number[];
  P: number;
  Q: number;
  R: number;
  stationaryCount: number;

  constructor() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.Q = 0.0001;
    this.R = 0.001;
    this.stationaryCount = 0;
  }

  update(measurement: number[], dt: number, accuracy: number, isStationary = false): number[] {
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

  reset(): void {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.stationaryCount = 0;
  }

  toJSON(): KalmanState {
    return {
      x: this.x, v: this.v, P: this.P,
      Q: this.Q, R: this.R,
      stationaryCount: this.stationaryCount,
    };
  }

  fromJSON(data: Partial<KalmanState> | null): void {
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
export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Process Location ────────────────────────────────────────────────
export function processLocation(
  newLat: number,
  newLng: number,
  prevEntry: ProcessedLocation | null,
  kalman: KalmanFilter2D,
  accuracy: number | null = null,
  timestamp: number | null = null
): ProcessedLocation | null {
  return processLocationDetailed(
    newLat,
    newLng,
    prevEntry,
    kalman,
    accuracy,
    timestamp,
  ).location;
}

export function processLocationDetailed(
  newLat: number,
  newLng: number,
  prevEntry: ProcessedLocation | null,
  kalman: KalmanFilter2D,
  accuracy: number | null = null,
  timestamp: number | null = null
): ProcessLocationResult {
  if (
    typeof newLat !== 'number' || typeof newLng !== 'number' ||
    newLat < -90 || newLat > 90 || newLng < -180 || newLng > 180
  ) return { location: null, reason: 'invalid_coordinates' };

  const normalizedAccuracy =
    typeof accuracy === 'number' && isFinite(accuracy)
      ? accuracy
      : ACCURACY_THRESHOLD;

  // Reject only genuinely bogus accuracy values (zero/negative).
  // The accuracy gate proper is applied below, AFTER the bypass paths
  // (first ping, post-gap reset) — so the seed always lands regardless
  // of how noisy the device's first reading is.
  if (normalizedAccuracy <= 0) return { location: null, reason: 'invalid_accuracy' };

  const now = timestamp || Date.now();

  // ── BYPASS 1: No previous point — accept the very first ping
  // unconditionally. This is what /users/active depends on populating
  // the moment Start Monitoring is tapped, even if the device's first
  // fix is cell-tower-only and 1500 m accurate.
  if (!prevEntry) {
    const filtered = kalman.update([newLat, newLng], 1, normalizedAccuracy);
    return {
      location: { latitude: filtered[0], longitude: filtered[1], timestamp: now },
      reason: null,
    };
  }

  const gapSeconds = (now - prevEntry.timestamp) / 1000;

  // ── BYPASS 2: Long gap since last ping — also accept unconditionally.
  // Treat as a fresh start (re-open after Doze, app relaunch, etc.).
  if (gapSeconds > GAP_RESET_SECONDS) {
    console.log(
      `[gps] Gap detected: ${gapSeconds.toFixed(0)}s — accepting as fresh start`
    );
    kalman.reset();
    const filtered = kalman.update([newLat, newLng], 1, normalizedAccuracy);
    return {
      location: { latitude: filtered[0], longitude: filtered[1], timestamp: now },
      reason: null,
    };
  }

  // ── Continuous-ping path: now apply the strict accuracy gate. Cell-
  // tower fixes (~500–3000 m) get rejected here, keeping the trail
  // clean when the user is stationary.
  if (normalizedAccuracy > ACCURACY_THRESHOLD) {
    return { location: null, reason: 'accuracy_too_low_precision' };
  }

  const dt = Math.min(gapSeconds, MAX_DT);
  if (dt <= 0) return { location: null, reason: 'non_positive_dt' };

  const rawDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    newLat, newLng
  );

  // Scale the jump bound with dt. A fixed 300 m cap works for short
  // foreground cadences but falsely rejects legitimate T1 movement when
  // the passive cadence stretches to 60 s.
  const maxJumpDist = Math.max(MAX_JUMP_DIST, MAX_JUMP_SPEED_MS * dt);
  if (rawDist > maxJumpDist) return { location: null, reason: 'jump_too_large' };

  const rawSpeed = rawDist / dt;
  if (rawSpeed > MAX_SPEED_MS) return { location: null, reason: 'raw_speed_too_high' };

  const isStationary = rawDist < STATIONARY_THRESHOLD;

  if (isStationary) {
    kalman.update([prevEntry.latitude, prevEntry.longitude], dt, normalizedAccuracy, true);
    return {
      location: {
        latitude: prevEntry.latitude,
        longitude: prevEntry.longitude,
        timestamp: now,
      },
      reason: null,
    };
  }

  const filtered = kalman.update([newLat, newLng], dt, normalizedAccuracy, false);
  const filteredDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    filtered[0], filtered[1]
  );

  if (filteredDist / dt > MAX_SPEED_MS) {
    return { location: null, reason: 'filtered_speed_too_high' };
  }

  return {
    location: { latitude: filtered[0], longitude: filtered[1], timestamp: now },
    reason: null,
  };
}

// ── Per-user state — Redis-backed ───────────────────────────────────
let _redis: RedisClient | null = null;
const memCache = new Map<string, GpsUserState>();

export function initGpsState(redisClient: RedisClient): void {
  _redis = redisClient;
}

interface SavedGpsState {
  prev: ProcessedLocation | null;
  kalman: Partial<KalmanState>;
  filterStreak: number;
}

export async function getUserState(userId: string): Promise<GpsUserState> {
  if (memCache.has(userId)) return memCache.get(userId)!;

  const stateKey = `gpsstate:${userId}`;
  try {
    const raw = _redis ? await _redis.get(stateKey) : null;
    if (raw) {
      const saved: SavedGpsState = JSON.parse(raw);
      const kalman = new KalmanFilter2D();
      kalman.fromJSON(saved.kalman);
      const state: GpsUserState = {
        prev: saved.prev || null,
        kalman,
        filterStreak: saved.filterStreak || 0,
      };
      memCache.set(userId, state);
      console.log(`[gps] Restored state for ${userId} from Redis`);
      return state;
    }
  } catch (e) {
    console.error('[gps] Failed to restore state:', (e as Error).message);
  }

  const state: GpsUserState = { prev: null, kalman: new KalmanFilter2D(), filterStreak: 0 };
  memCache.set(userId, state);
  return state;
}

export async function saveUserState(userId: string): Promise<void> {
  const state = memCache.get(userId);
  if (!state || !_redis) return;
  try {
    await _redis.setEx(`gpsstate:${userId}`, 86400, JSON.stringify({
      prev: state.prev,
      kalman: state.kalman.toJSON(),
      filterStreak: state.filterStreak,
    }));
  } catch (e) {
    console.error('[gps] Failed to save state:', (e as Error).message);
  }
}

export function clearUserState(userId: string): void {
  memCache.delete(userId);
  if (_redis) _redis.del(`gpsstate:${userId}`).catch(() => {});
}
