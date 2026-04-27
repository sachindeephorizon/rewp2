import { Router, type Request, type Response } from "express";
import { redis } from "../redis";
import { pool } from "../db";
import { getIo } from "../socket";
import {
  processLocationDetailed,
  getUserState,
  saveUserState,
  clearUserState,
  haversineDistance,
  MAX_FILTER_STREAK,
  GAP_RESET_SECONDS,
} from "../utils/gps";
import { reverseGeocode } from "../utils/geocode";
import { rateLimitPing } from "../utils/rateLimit";
import { snapToRoad, snapTrajectory } from "../utils/snapToRoad";
import { latLngToH3Cell } from "../utils/h3corridor";
import {
  LOCATION_TTL,
  SESSION_TTL,
  TRAIL_MIN_DISTANCE,
  CHANNEL,
  ACTIVE_SET,
} from "../config";
import { buildStreamMetadata } from "../utils/stream";
import type { StreamMetadata, DestinationData, DeviationAlert, LocationPayload, PingBody, SessionMeta } from "../types";
import {
  escalateOnInactivity,
  escalateOnDeviation,
  getCheckinSnapshot,
} from "./checkin";

const router = Router();

// ── Deviation streak helpers (Redis-backed) ──────────────────────────────────

async function getDeviationStreak(userId: string): Promise<number> {
  try {
    const raw = await redis.get(`devstreak:${userId}`);
    return raw ? (JSON.parse(raw) as { count: number }).count : 0;
  } catch {
    return 0;
  }
}

async function setDeviationStreak(userId: string, count: number): Promise<void> {
  await redis.set(
    `devstreak:${userId}`,
    JSON.stringify({ count }),
    { EX: SESSION_TTL }
  );
}

async function clearDeviationStreak(userId: string): Promise<void> {
  await redis.del(`devstreak:${userId}`);
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

const toNullableNumber = (value: unknown): number | null => (
  typeof value === "number" && Number.isFinite(value) ? value : null
);

interface BuildLocationPayloadParams {
  userId: string;
  streamMeta: StreamMetadata;
  sessionStartedAt: string;
  now: string;
  finalLat: number;
  finalLng: number;
  body: PingBody;
}

const buildLocationPayload = ({
  userId,
  streamMeta,
  sessionStartedAt,
  now,
  finalLat,
  finalLng,
  body,
}: BuildLocationPayloadParams): LocationPayload => ({
  event: "location_update",
  userId,
  driverId: streamMeta.driverId,
  sessionId: streamMeta.sessionId,
  streamKey: streamMeta.streamKey,
  rideChannel: streamMeta.rideChannel,
  lat: finalLat,
  lng: finalLng,
  speed: toNullableNumber(body.speed),
  accuracy: toNullableNumber(body.accuracy),
  heading: toNullableNumber(body.heading),
  moving: typeof body.moving === "boolean" ? body.moving : null,
  distance: toNullableNumber(body.distance),
  activity: typeof body.activity === "string" ? body.activity : null,
  source: typeof body.source === "string" ? body.source : null,
  appState: typeof body.appState === "string" ? body.appState : null,
  sequence: Number.isInteger(body.sequence) ? body.sequence! : null,
  gpsIntervalMs: toNullableNumber(body.gpsIntervalMs),
  timestamp: now,
  gpsTimestamp: toNullableNumber(body.timestamp),
  startedAt: sessionStartedAt,
  roomNames: streamMeta.roomNames,
});

// ── Deviation zone check ─────────────────────────────────────────────────────

async function checkDeviation(
  userId: string,
  lat: number,
  lng: number,
  streamMeta: StreamMetadata,
  destData: DestinationData
): Promise<{ alert: DeviationAlert | null; streak: number }> {
  const devCell = latLngToH3Cell(lat, lng, 10);
  const [inInner, inOuter, prevCount] = await Promise.all([
    redis.sIsMember(`nav:inner:${userId}`, devCell),
    redis.sIsMember(`nav:outer:${userId}`, devCell),
    getDeviationStreak(userId),
  ]);

  if (inInner) {
    await setDeviationStreak(userId, 0);
    const activeDev = await redis.get(`deviation:${userId}`);
    if (activeDev) {
      await redis.del(`deviation:${userId}`);
      pool.query(
        `UPDATE deviations SET resolved_at = NOW() WHERE user_id = $1 AND resolved_at IS NULL`,
        [userId]
      ).catch(() => {});
      pool.query(
        `INSERT INTO session_events (user_id, event_type, lat, lng) VALUES ($1, $2, $3, $4)`,
        [userId, 'deviation_cleared', lat, lng]
      ).catch(() => {});
    }
    return { alert: null, streak: 0 };
  }

  if (inOuter) {
    return { alert: null, streak: prevCount };
  }

  const newCount = prevCount + 1;
  await setDeviationStreak(userId, newCount);

  console.log(`[deviation] ${userId} OUTSIDE corridor | streak=${newCount}`);

  // Severity reflects the CURRENT streak, not just threshold crossings.
  // Previously this was `newCount === LONG_DEV_STREAK`, which fires the
  // "long" alert exactly once at streak 8 and never again — meaning a
  // dashboard subscribed to deviation events sees "short" for streaks
  // 3-7 and only catches "long" if it happens to be online at exactly
  // streak 8. With `>= LONG_DEV_STREAK` the alert keeps firing as "long"
  // through streak 9, 10, 11... so any dashboard refresh shows the real
  // current severity instead of stale "short".
  let severity: 'short' | 'long' | null = null;
  if (newCount >= LONG_DEV_STREAK) severity = 'long';
  else if (newCount >= SHORT_DEV_STREAK) severity = 'short';
  if (!severity) return { alert: null, streak: newCount };

  // Don't spam pool.query inserts on every outside ping — that would
  // create thousands of `deviations` rows per long detour. Only the
  // threshold-crossing pings (3 and 8 exactly) write to Postgres / call
  // escalateOnDeviation. Subsequent pings only refresh the redis snapshot
  // and re-publish the live event so dashboards stay in sync.
  const isCrossing =
    newCount === SHORT_DEV_STREAK || newCount === LONG_DEV_STREAK;

  const alert: DeviationAlert = {
    userId,
    lat,
    lng,
    h3Cell: devCell,
    zone: severity === 'long' ? 'OUTSIDE_LONG' : 'OUTSIDE_SHORT',
    consecutive: newCount,
    destinationName: destData.name || null,
    detectedAt: new Date().toISOString(),
    // ts-expect-error keep DeviationAlert type loose; clients also read severity
    severity,
  } as DeviationAlert & { severity: 'short' | 'long' };

  await redis.set(`deviation:${userId}`, JSON.stringify(alert), { EX: SESSION_TTL });

  await redis.publish(CHANNEL, JSON.stringify({
    event: "deviation_alert",
    ...alert,
    roomNames: streamMeta.roomNames,
    streamKey: streamMeta.streamKey,
  }));

  if (isCrossing) {
    pool.query(
      `INSERT INTO deviations (user_id, lat, lng, h3_cell, zone, consecutive, destination_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, lat, lng, devCell, alert.zone, newCount, destData.name || null]
    ).catch((e: Error) => console.error("[deviation] DB insert failed:", e.message));

    pool.query(
      `INSERT INTO session_events (user_id, event_type, lat, lng, h3_cell, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, 'deviation_detected', lat, lng, devCell, JSON.stringify({ severity, consecutive: newCount, destinationName: destData.name })]
    ).catch(() => {});

    // Bump check-in tier in-process (no HTTP round trip). Only on the
    // threshold-crossing pings to avoid re-pushing the same signal every
    // ping (the tier engine already has it at this point).
    escalateOnDeviation(userId, severity).catch((e: Error) =>
      console.error('[deviation] escalateOnDeviation failed:', e.message)
    );

    console.log(`[deviation] 🚨 ${userId} ${severity.toUpperCase()} alert | streak=${newCount}`);
  }
  return { alert, streak: newCount };
}

// ── Deviation classification thresholds ──────────────────────────────────────
// Streak counts of consecutive pings outside the H3 corridor.
//   3..7   → "short"  → bump check-in tier to T2
//   ≥ 8    → "long"   → bump check-in tier to T3
//
// NOTE: client doesn't duplicate these — it reads `severity` off the ping
// response. If you change them, the rewp2 → client contract still holds via
// DeviationAlert.severity in src/api/monitoring.ts on the client.
const SHORT_DEV_STREAK = 3;
const LONG_DEV_STREAK = 8;

// ── Arrival check ────────────────────────────────────────────────────────────

const ARRIVAL_RADIUS_M = 200;

// ── Inactivity (distance-window) ─────────────────────────────────────────────
// Per PRD: distance covered in the last 10 min < 30 m AND not near destination.
//
// MUST stay in sync with the client's TierSignalService:
//   src/features/monitoring/tierSignal.ts → INACTIVITY_WINDOW_MS, INACTIVITY_DISTANCE_M
//   src/features/monitoring/MonitoringSession.tsx → NEAR_DESTINATION_M
const INACTIVITY_WINDOW_S = 600;          // 10 minutes
const INACTIVITY_DISTANCE_M = 30;         // total displacement threshold
const INACTIVITY_NEAR_DEST_M = ARRIVAL_RADIUS_M * 2; // 400 m — suppress when ≈ at destination

interface InactivitySample {
  t: number;   // epoch ms
  lat: number;
  lng: number;
}

async function pushInactivitySample(userId: string, sample: InactivitySample): Promise<void> {
  const key = `inactwin:${userId}`;
  await redis.rPush(key, JSON.stringify(sample));
  await redis.expire(key, SESSION_TTL);
  // Trim anything older than the window from the head (cheap when window is short).
  const cutoff = Date.now() - INACTIVITY_WINDOW_S * 1000;
  const head = await redis.lRange(key, 0, 0);
  if (head.length > 0) {
    try {
      const first = JSON.parse(head[0]) as InactivitySample;
      if (first.t < cutoff) {
        const all = await redis.lRange(key, 0, -1);
        const kept = all
          .map((s) => JSON.parse(s) as InactivitySample)
          .filter((s) => s.t >= cutoff)
          .map((s) => JSON.stringify(s));
        await redis.del(key);
        if (kept.length > 0) {
          await redis.rPush(key, kept);
          await redis.expire(key, SESSION_TTL);
        }
      }
    } catch {
      // best-effort
    }
  }
}

async function getWindowDisplacement(userId: string): Promise<{ samples: number; maxDisplacementM: number; spanS: number }> {
  const raw = await redis.lRange(`inactwin:${userId}`, 0, -1);
  if (raw.length < 2) return { samples: raw.length, maxDisplacementM: 0, spanS: 0 };
  const samples: InactivitySample[] = raw.map((s) => JSON.parse(s));
  // Use the *anchor* (oldest) point and check displacement of every other
  // sample from it. Max-displacement matches the user spec — we want to know
  // if the user has moved AT ALL in the window, not just the cumulative
  // jitter from GPS noise.
  const anchor = samples[0];
  let max = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = haversineDistance(anchor.lat, anchor.lng, samples[i].lat, samples[i].lng);
    if (d > max) max = d;
  }
  const spanS = (samples[samples.length - 1].t - anchor.t) / 1000;
  return { samples: samples.length, maxDisplacementM: max, spanS };
}

async function clearInactivityWindow(userId: string): Promise<void> {
  await redis.del(`inactwin:${userId}`);
}

async function checkArrival(
  userId: string,
  lat: number,
  lng: number,
  destData: DestinationData,
  streamMeta: StreamMetadata,
  now: string | null
): Promise<boolean> {
  const distToDest = haversineDistance(lat, lng, destData.destination.lat, destData.destination.lng);
  if (distToDest >= ARRIVAL_RADIUS_M) return false;

  console.log(`[arrival] ✅ ${userId} arrived (${Math.round(distToDest)}m from dest)`);

  pool.query(
    `INSERT INTO session_events (user_id, event_type, lat, lng, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, 'arrival_detected', lat, lng, JSON.stringify({ distanceToDest: Math.round(distToDest), destinationName: destData.name })]
  ).catch(() => {});

  await Promise.all([
    redis.del(`nav:dest:${userId}`),
    redis.del(`nav:corridor:${userId}`),
    redis.del(`nav:inner:${userId}`),
    redis.del(`nav:outer:${userId}`),
    redis.del(`nav:route:${userId}`),
    redis.del(`deviation:${userId}`),
    redis.del(`devstreak:${userId}`),
    redis.del(`inactivity:${userId}`),
    redis.del(`inactwin:${userId}`),
  ]);

  await redis.publish(CHANNEL, JSON.stringify({
    event: "arrival_detected",
    userId,
    lat,
    lng,
    distanceToDest: Math.round(distToDest),
    destinationName: destData.name || null,
    timestamp: now || new Date().toISOString(),
    roomNames: streamMeta.roomNames,
    streamKey: streamMeta.streamKey,
  }));

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

// NOTE: rateLimitPing middleware was removed. Frontend already throttles
// (per-tier stationary cooldown + watcher cadence). Backend should record
// every ping the client decides to send rather than 429-ing legitimate
// background-batch deliveries — the user wants raw recording, no double
// filtering. Kalman smoothing still runs for snap-to-road visuals, but we
// no longer REJECT pings based on its verdict (see below).
router.post("/:id/ping", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id as string;
    const body = req.body as PingBody;
    const { lat, lng, accuracy, timestamp } = body;

    if (!userId || typeof userId !== "string") {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(400).json({ error: "lat and lng are required numbers" });
      return;
    }
    if (lat < -90 || lat > 90) { res.status(400).json({ error: "lat must be between -90 and 90" }); return; }
    if (lng < -180 || lng > 180) { res.status(400).json({ error: "lng must be between -180 and 180" }); return; }

    // ── ISSUE 7 FIX: Reject any ping that arrives after /stop. The mobile
    // background task may keep firing for a few seconds while the OS tears
    // it down — without this guard, those zombie pings re-create the
    // session in Redis and the dashboard "user is still active". The flag
    // is set in /stop with a 5-minute TTL.
    const stoppedFlag = await redis.get(`stopped:${userId}`);
    if (stoppedFlag) {
      res.status(200).json({ ok: true, stopped: true, reason: "session_stopped" });
      return;
    }

    const userAccuracy = typeof accuracy === "number" ? accuracy : null;
    const userTimestamp = typeof timestamp === "number" ? timestamp : null;

    const streamMeta = buildStreamMetadata({
      userId,
      sessionId: body.sessionId,
      rideChannel: body.rideChannel,
      driverId: body.driverId,
    });

    const state = await getUserState(userId);

    if (state.prev && userTimestamp) {
      const gapSeconds = (userTimestamp - state.prev.timestamp) / 1000;
      if (gapSeconds > GAP_RESET_SECONDS) {
        console.log(`[ping] Gap of ${gapSeconds.toFixed(0)}s detected for ${userId} - resetting state`);
        state.prev = null;
        state.kalman.reset();
        state.filterStreak = 0;
      }
    }

    const processedResult = processLocationDetailed(
      lat, lng,
      state.prev,
      state.kalman,
      userAccuracy,
      userTimestamp
    );
    // No more "filtered" early-exit. The frontend already gates pings via
    // the per-tier stationary cooldown and watcher cadence; the backend's
    // job is to record what arrives, not second-guess it.
    //
    // Kalman still runs (its smoothed output is what we feed to snap-to-road
    // for clean trail visuals), but if it rejects the fix as a spike we
    // fall back to the raw client coords rather than dropping the ping.
    const processed =
      processedResult.location ?? {
        latitude: lat,
        longitude: lng,
        timestamp: userTimestamp ?? Date.now(),
      };

    state.filterStreak = 0;

    const prevState = state.prev;
    const isRealMovement =
      !prevState ||
      prevState.latitude !== processed.latitude ||
      prevState.longitude !== processed.longitude;

    state.prev = processed;
    await saveUserState(userId);

    const snapped = isRealMovement
      ? await snapToRoad(processed.latitude, processed.longitude)
      : { lat: processed.latitude, lng: processed.longitude, snapped: false };

    const finalLat = snapped.lat;
    const finalLng = snapped.lng;

    const h3Cell = latLngToH3Cell(finalLat, finalLng, 10);

    const now = new Date().toISOString();
    const redisKey = `user:${userId}`;
    const sessionStartKey = `session:${userId}:start`;
    const sessionMetaKey = `session:${userId}:meta`;
    const sessionLogsKey = `session:${userId}:logs`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    const existingSession = await redis.get(sessionStartKey);
    const isFirstPing = !existingSession;

    let addTrailDot = false;
    const lastDotRaw = await redis.lIndex(trailKey, -1);
    if (!lastDotRaw) {
      addTrailDot = true;
    } else {
      const lastDot = JSON.parse(lastDotRaw) as { lat: number; lng: number };
      if (haversineDistance(lastDot.lat, lastDot.lng, finalLat, finalLng) >= TRAIL_MIN_DISTANCE) {
        addTrailDot = true;
      }
    }

    const sessionStartedAt = existingSession || now;
    // ── ISSUE 3 FIX: Broadcast RAW GPS coords to the dashboard, not the
    // Kalman-filtered + snap-to-road coords. Snap-to-road causes the live
    // dot to jitter when consecutive pings project to slightly different
    // road-network points. Filtered coords (finalLat/finalLng) are still
    // used below for trail/session-logs/DB so the persisted track stays
    // clean — only the live dot uses raw.
    const payload = buildLocationPayload({
      userId, streamMeta, sessionStartedAt, now, finalLat: lat, finalLng: lng, body,
    });
    payload.h3Cell = latLngToH3Cell(lat, lng, 10);

    let locationPoint = JSON.stringify({
      lat: finalLat,
      lng: finalLng,
      h3Cell,
      timestamp: now,
      accuracy: payload.accuracy,
      speed: payload.speed,
      heading: payload.heading,
      moving: payload.moving,
      activity: payload.activity,
      source: payload.source,
      sequence: payload.sequence,
      deviationFlag: false,
      inactivityFlag: false,
    });

    const sessionMeta: SessionMeta = {
      userId,
      driverId: streamMeta.driverId,
      sessionId: streamMeta.sessionId,
      streamKey: streamMeta.streamKey,
      rideChannel: streamMeta.rideChannel,
      roomNames: streamMeta.roomNames,
      startedAt: sessionStartedAt,
      latestTimestamp: now,
      appState: payload.appState,
      source: payload.source,
      gpsIntervalMs: payload.gpsIntervalMs,
    };

    const redisOps: Promise<unknown>[] = [
      redis.setEx(redisKey, LOCATION_TTL, JSON.stringify(payload)),
      redis.setEx(sessionMetaKey, SESSION_TTL, JSON.stringify(sessionMeta)),
      redis.sAdd(ACTIVE_SET, userId),
    ];

    // NOTE: previously we published the bare-bones `payload` here. Moved to
    // the end of the handler so the live dashboard payload includes
    // tier/deviation/inactivity/missed-checkin state computed below.
    // Without that move, dashboards saw raw lat/lng only, and "tier"
    // never updated unless the dashboard separately polled /handling/checkin.

    if (isFirstPing) {
      try {
        const [oldStart, oldLogs] = await Promise.all([
          redis.get(sessionStartKey),
          redis.lRange(sessionLogsKey, 0, -1),
        ]);
        if (oldStart && oldLogs && oldLogs.length > 0) {
          const parsedOldLogs = oldLogs.map((l) => JSON.parse(l) as {
            lat: number;
            lng: number;
            h3Cell?: string;
            speed?: number;
            accuracy?: number;
            deviationFlag?: boolean;
            inactivityFlag?: boolean;
            timestamp: string;
          });
          const oldSessionStart = new Date(oldStart);
          const oldNow = new Date();
          const oldDuration = Math.floor((oldNow.getTime() - oldSessionStart.getTime()) / 1000);

          const countRes = await pool.query(
            "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1", [userId]
          );
          const num = parseInt(countRes.rows[0].cnt as string, 10) + 1;
          const oldName = `session${num}`;
          const firstOld = parsedOldLogs[0];
          const lastOld = parsedOldLogs[parsedOldLogs.length - 1];

          const [startLoc, endLoc] = await Promise.all([
            firstOld ? reverseGeocode(firstOld.lat, firstOld.lng) : null,
            lastOld ? reverseGeocode(lastOld.lat, lastOld.lng) : null,
          ]);

          const sResult = await pool.query(
            `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings, start_location, end_location)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [userId, oldName, oldSessionStart, oldNow, oldDuration, parsedOldLogs.length, startLoc, endLoc]
          );
          const oldSid = sResult.rows[0].id as number;

          const batchSize = 500;
          for (let b = 0; b < parsedOldLogs.length; b += batchSize) {
            const batch = parsedOldLogs.slice(b, b + batchSize);
            const vals: string[] = [];
            const params: (number | string | boolean | null)[] = [];
            batch.forEach((point, index) => {
              const offset = index * 9;
              vals.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9})`);
              const speedKmh = typeof point.speed === 'number' ? point.speed * 3.6 : null;
              params.push(
                oldSid,
                point.lat,
                point.lng,
                point.h3Cell || null,
                speedKmh,
                point.accuracy || null,
                !!point.deviationFlag,
                !!point.inactivityFlag,
                point.timestamp,
              );
            });
            await pool.query(
              `INSERT INTO location_logs (session_id, lat, lng, h3_cell, speed_kmh, accuracy_m, deviation_flag, inactivity_flag, recorded_at) VALUES ${vals.join(",")}`,
              params
            );
          }
          console.log(`[ping] Saved orphan session: ${oldName} | ${parsedOldLogs.length} pts`);
        }
      } catch (e) {
        console.error("[ping] Failed to save orphan session:", (e as Error).message);
      }

      redisOps.push(redis.del(sessionLogsKey));
      redisOps.push(redis.del(trailKey));
      redisOps.push(redis.set(sessionStartKey, now));
      redisOps.push(redis.expire(sessionStartKey, SESSION_TTL));
      redisOps.push(redis.rPush(sessionLogsKey, locationPoint));
      redisOps.push(redis.expire(sessionLogsKey, SESSION_TTL));

      const startMarker = JSON.stringify({
        lat: processed.latitude,
        lng: processed.longitude,
        timestamp: now,
        streamKey: streamMeta.streamKey,
      });
      redisOps.push(redis.set(startMarkerKey, startMarker));
      redisOps.push(redis.expire(startMarkerKey, SESSION_TTL));

      pool.query(
        `INSERT INTO session_events (user_id, event_type, lat, lng, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, 'session_started', finalLat, finalLng, JSON.stringify({ sessionId: streamMeta.sessionId, source: payload.source })]
      ).catch(() => {});
    } else {
      redisOps.push(redis.rPush(sessionLogsKey, locationPoint));
      redisOps.push(redis.expire(sessionLogsKey, SESSION_TTL));
      redisOps.push(redis.expire(trailKey, SESSION_TTL));
    }

    if (addTrailDot) {
      redisOps.push(redis.rPush(trailKey, JSON.stringify({
        lat: processed.latitude,
        lng: processed.longitude,
        timestamp: now,
      })));
    }

    await Promise.all(redisOps);

    // ── Navigation intelligence ───────────────────────────────────────────────

        let deviationAlert: DeviationAlert | null = null;
    let arrivalDetected = false;
    let inactivityFlag = false;
    let devStreak = 0;

    const destRaw = await redis.get(`nav:dest:${userId}`);
    if (destRaw) {
      const destData = JSON.parse(destRaw) as DestinationData;

      const rawLat = lat;
      const rawLng = lng;

      arrivalDetected = await checkArrival(userId, rawLat, rawLng, destData, streamMeta, now);

      if (!arrivalDetected) {
        const devResult = await checkDeviation(userId, rawLat, rawLng, streamMeta, destData);
        deviationAlert = devResult.alert;
        devStreak = devResult.streak;

        // Distance-window inactivity:
        //   distance covered in last 10 min < 30 m AND not near destination.
        const distToDest = haversineDistance(
          rawLat, rawLng,
          destData.destination.lat, destData.destination.lng
        );
        const nearDest = distToDest <= INACTIVITY_NEAR_DEST_M;

        if (nearDest) {
          await clearInactivityWindow(userId);
        } else {
          await pushInactivitySample(userId, { t: Date.now(), lat: finalLat, lng: finalLng });
          const win = await getWindowDisplacement(userId);
          if (win.spanS >= INACTIVITY_WINDOW_S && win.maxDisplacementM < INACTIVITY_DISTANCE_M) {
            inactivityFlag = true;
            console.log(`[inactivity] ⚠️ ${userId} <${INACTIVITY_DISTANCE_M}m in ${Math.round(win.spanS)}s (${win.samples} samples)`);

            pool.query(
              `INSERT INTO session_events (user_id, event_type, lat, lng, metadata)
               VALUES ($1, $2, $3, $4, $5)`,
              [userId, 'inactivity_detected', finalLat, finalLng, JSON.stringify({
                windowSecs: Math.round(win.spanS),
                maxDisplacementM: Math.round(win.maxDisplacementM),
                samples: win.samples,
              })]
            ).catch(() => {});

            await redis.publish(CHANNEL, JSON.stringify({
              event: "inactivity_alert",
              userId,
              lat: finalLat,
              lng: finalLng,
              windowSecs: Math.round(win.spanS),
              maxDisplacementM: Math.round(win.maxDisplacementM),
              destinationName: destData.name || null,
              timestamp: now,
              roomNames: streamMeta.roomNames,
              streamKey: streamMeta.streamKey,
            }));

            // Bump check-in tier (T1 → T2). Idempotent if already at T2/T3.
            escalateOnInactivity(userId).catch((e: Error) =>
              console.error('[inactivity] escalateOnInactivity failed:', e.message)
            );

            // Reset the window so we don't keep re-firing every ping.
            await clearInactivityWindow(userId);
          }
        }
      }
    } else {
      // No destination set — still track inactivity (bearing-only sessions),
      // but skip the near-destination guard.
      await pushInactivitySample(userId, { t: Date.now(), lat: finalLat, lng: finalLng });
      const win = await getWindowDisplacement(userId);
      if (win.spanS >= INACTIVITY_WINDOW_S && win.maxDisplacementM < INACTIVITY_DISTANCE_M) {
        inactivityFlag = true;
        escalateOnInactivity(userId).catch(() => {});
        await clearInactivityWindow(userId);
      }
    }

    // Force-location request handling
    const locReqKey = `locreq:${userId}`;
    let forceRefresh = false;

    if (body.source === "force_request") {
      await redis.del(locReqKey);
    } else {
      const pending = await redis.get(locReqKey);
      if (pending) forceRefresh = true;
    }

    const tierSnap = getCheckinSnapshot(userId);

    try {
      const parsedPoint = JSON.parse(locationPoint) as Record<string, unknown>;
      parsedPoint.deviationFlag = devStreak > 0;
      parsedPoint.inactivityFlag = inactivityFlag;
      locationPoint = JSON.stringify(parsedPoint);
    } catch {
      // best-effort only
    }

    // Enriched live payload — same shape as `payload` but augmented with
    // every monitoring signal the dashboard cares about. Keeps /users/active
    // and the live socket feed in lockstep with the response the mobile
    // client received this same call.
    const enrichedPayload: Record<string, unknown> = {
      ...(payload as unknown as Record<string, unknown>),
      h3Cell,
      deviationFlag: devStreak > 0,
      deviationSeverity: devStreak >= LONG_DEV_STREAK
        ? 'long'
        : devStreak >= SHORT_DEV_STREAK
          ? 'short'
          : null,
      deviationStreak: devStreak,
      inactivityFlag,
      arrivalDetected,
      tier: tierSnap?.tier ?? null,
      tierName: tierSnap?.tier_name ?? null,
      intervalMinutes: tierSnap?.interval_minutes ?? null,
      nextCheckinAt: tierSnap?.next_checkin_at ?? null,
      missedCheckin: tierSnap?.missed ?? false,
    };

    if (isRealMovement || isFirstPing) {
      // Single publish with the full state. Dashboards subscribed to
      // `locationUpdate` / `stream:update` get tier + deviation + missed
      // checkin on every movement ping, no separate polling needed.
      redis.publish(CHANNEL, JSON.stringify(enrichedPayload)).catch(() => {});
    }

    res.status(200).json({
      ok: true,
      data: payload,
      forceRefresh,
      deviationAlert,
      // ── ISSUE 1 FIX: deviationAlert is null between threshold crossings
      // (streak ∈ {3,8} only). deviationFlag tells the client whether the
      // user is CURRENTLY off-corridor regardless of threshold events, so
      // the UI can keep showing "deviated" until they're back on track.
      deviationFlag: devStreak > 0,
      // ── ISSUE 2 FIX: body.speed is m/s (from expo-location); the
      // dashboard wants km/h. Add a converted field so neither side has
      // to remember to multiply by 3.6.
      speedKmh: typeof body.speed === 'number' && Number.isFinite(body.speed) ? Math.round(body.speed * 3.6 * 10) / 10 : null,
      arrivalDetected,
      inactivityFlag,
      tier: tierSnap?.tier ?? null,
      tierName: tierSnap?.tier_name ?? null,
      intervalMinutes: tierSnap?.interval_minutes ?? null,
      nextCheckinAt: tierSnap?.next_checkin_at ?? null,
      missedCheckin: tierSnap?.missed ?? false,
    });
  } catch (err) {
    console.error("[POST /:id/ping] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── STOP ──────────────────────────────────────────────────────────────────────

router.post("/:id/stop", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id as string;
    const now = new Date();

    const sessionStartKey = `session:${userId}:start`;
    const sessionMetaKey = `session:${userId}:meta`;
    const sessionLogsKey = `session:${userId}:logs`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    const [startedAt, sessionMetaRaw, logs, trailDots, startMarkerRaw] = await Promise.all([
      redis.get(sessionStartKey),
      redis.get(sessionMetaKey),
      redis.lRange(sessionLogsKey, 0, -1),
      redis.lRange(trailKey, 0, -1),
      redis.get(startMarkerKey),
    ]);

    const storedSessionMeta: SessionMeta | null = sessionMetaRaw ? JSON.parse(sessionMetaRaw) : null;

    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1", [userId]
    );
    const sessionNumber = parseInt(countResult.rows[0].cnt as string, 10) + 1;
    const sessionName = `session${sessionNumber}`;

    const sessionStart = startedAt ? new Date(startedAt) : now;
    const durationSecs = Math.floor((now.getTime() - sessionStart.getTime()) / 1000);
    const parsedLogs = logs.map((l) => JSON.parse(l) as {
      lat: number; lng: number; h3Cell?: string; speed?: number;
      accuracy?: number; deviationFlag?: boolean; inactivityFlag?: boolean; timestamp: string;
    });

    const firstLog = parsedLogs[0];
    const lastLog = parsedLogs[parsedLogs.length - 1];

    const [startLocation, endLocation] = await Promise.all([
      firstLog ? reverseGeocode(firstLog.lat, firstLog.lng) : null,
      lastLog ? reverseGeocode(lastLog.lat, lastLog.lng) : null,
    ]);

    const [destRaw, routeRaw, corridorRaw] = await Promise.all([
      redis.get(`nav:dest:${userId}`),
      redis.get(`nav:route:${userId}`),
      redis.get(`nav:corridor:${userId}`),
    ]);
    const destInfo: DestinationData | null = destRaw ? JSON.parse(destRaw) : null;

    const devCountRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM deviations WHERE user_id = $1 AND resolved_at IS NULL OR user_id = $1`,
      [userId]
    ).catch(() => ({ rows: [{ cnt: 0 }] }));

    // ── 1. STOP THE LIVE STREAM IMMEDIATELY ──────────────────────────────
    // Tear down the live signal BEFORE the slow DB writes so the dashboard
    // sees "user stopped" instantly and any in-flight pings get rejected
    // (their session no longer in ACTIVE_SET / has no user:* key).
    // Redis keys that hold the source data for the DB save (sessionLogsKey,
    // trailKey, sessionStartKey, sessionMetaKey, startMarkerKey) are
    // intentionally NOT deleted here — they're needed below.
    const finalLog = parsedLogs[parsedLogs.length - 1];
    const startMarker = startMarkerRaw ? JSON.parse(startMarkerRaw) as { lat: number; lng: number } : null;
    const stopMarker = finalLog ? { lat: finalLog.lat, lng: finalLog.lng } : null;

    const stopPayload = {
      event: "tracking_stopped",
      stopped: true,
      userId,
      driverId: storedSessionMeta?.driverId || userId,
      sessionId: storedSessionMeta?.sessionId || null,
      streamKey: storedSessionMeta?.streamKey || `stream:${userId}:live`,
      rideChannel: storedSessionMeta?.rideChannel || null,
      roomNames: storedSessionMeta?.roomNames || [],
      timestamp: now.toISOString(),
      endedAt: now.toISOString(),
      totalPings: parsedLogs.length,
      durationSecs,
    };

    await Promise.all([
      redis.del(`user:${userId}`),
      redis.del(`nav:dest:${userId}`),
      redis.del(`nav:corridor:${userId}`),
      redis.del(`nav:inner:${userId}`),
      redis.del(`nav:outer:${userId}`),
      redis.del(`nav:route:${userId}`),
      redis.del(`deviation:${userId}`),
      redis.del(`devstreak:${userId}`),
      redis.del(`inactwin:${userId}`),
      redis.del(`gpsstate:${userId}`),
      redis.sRem(ACTIVE_SET, userId),
      // ── ISSUE 7 FIX: Stamp a "stopped" gate so any ping that arrives
      // in the next 5 min (background task still draining, batched fixes
      // racing the stop call) gets rejected at /ping entry instead of
      // re-creating the session.
      redis.set(`stopped:${userId}`, '1', { EX: 300 }),
      redis.publish(CHANNEL, JSON.stringify(stopPayload)),
    ]);
    clearUserState(userId);

    // ── EMIT STOP EVENT DIRECTLY TO SOCKET.IO CLIENTS ───────────────────
    // Dashboard dashboards listen for 'locationUpdate' with stopped: true flag
    // Emit immediately so connected clients see the stop before the 5s poll
    const io = getIo();
    if (io) {
      const stopEvent = { ...stopPayload, stopped: true };
      io.emit("locationUpdate", stopEvent);
      console.log(`[stop] emitted stop event to Socket.IO for ${userId}`);
    }

    // ── 2. RESPOND TO THE CLIENT IMMEDIATELY ─────────────────────────────
    // The mobile UI no longer has to wait for the 9k-row INSERT loop. The
    // session id is unknown until the DB INSERT runs below; we send a
    // pending marker so the client can navigate to the summary screen,
    // which fetches the persisted session by user_id once it lands.
    res.status(200).json({
      ok: true,
      pending: true,                // session row + logs save in background
      userId,
      startedAt: sessionStart,
      endedAt: now,
      durationSecs,
      totalPings: parsedLogs.length,
      startLocation,
      endLocation,
      startMarker,
      stopMarker,
      stream: storedSessionMeta,
    });

    // ── 3. PERSIST TO POSTGRES IN BACKGROUND ─────────────────────────────
    // The live signal is already gone. The only thing left is durable
    // archival. We do it after the response so the user isn't blocked on
    // 9000-row inserts. Failure here does NOT roll back the stop — the
    // session is functionally over from the user's perspective.
    void (async () => {
      let dbSessionId: number | null = null;
      try {
        const sessionResult = await pool.query(
          `INSERT INTO sessions (
            user_id, session_name, status, started_at, ended_at, duration_secs, total_pings,
            start_location, end_location,
            origin_lat, origin_lng, dest_lat, dest_lng, dest_label,
            route_polyline, route_h3_corridor, deviation_count
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
          [
            userId, sessionName, 'completed', sessionStart, now, durationSecs, parsedLogs.length,
            startLocation, endLocation,
            destInfo?.origin?.lat || firstLog?.lat || null,
            destInfo?.origin?.lng || firstLog?.lng || null,
            destInfo?.destination?.lat || null,
            destInfo?.destination?.lng || null,
            destInfo?.name || null,
            routeRaw || null,
            corridorRaw || null,
            parseInt(devCountRes.rows[0].cnt as string, 10) || 0,
          ]
        );
        dbSessionId = sessionResult.rows[0].id as number;

        const batchSize = 500;
        for (let b = 0; b < parsedLogs.length; b += batchSize) {
          const batch = parsedLogs.slice(b, b + batchSize);
          const values: string[] = [];
          const params: (number | string | boolean | null)[] = [];
          batch.forEach((point, index) => {
            const offset = index * 9;
            values.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9})`);
            const speedKmh = typeof point.speed === 'number' ? point.speed * 3.6 : null;
            const accuracyVal = typeof point.accuracy === 'number' ? point.accuracy : null;
            params.push(
              dbSessionId,
              point.lat,
              point.lng,
              point.h3Cell || null,
              speedKmh,
              accuracyVal,
              !!point.deviationFlag,
              !!point.inactivityFlag,
              point.timestamp,
            );
          });
          await pool.query(
            `INSERT INTO location_logs (session_id, lat, lng, h3_cell, speed_kmh, accuracy_m, deviation_flag, inactivity_flag, recorded_at) VALUES ${values.join(",")}`,
            params
          );
        }

        const lastPt = parsedLogs[parsedLogs.length - 1];
        await pool.query(
          `INSERT INTO session_events (session_id, user_id, event_type, lat, lng, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [dbSessionId, userId, 'session_ended', lastPt?.lat, lastPt?.lng, JSON.stringify({ durationSecs, totalPings: parsedLogs.length, sessionName })]
        ).catch(() => {});

        console.log(`[stop] persisted ${sessionName} | ${parsedLogs.length} pts | ${durationSecs}s`);

        // Now safe to delete source-of-truth Redis keys — DB has the data.
        await Promise.all([
          redis.del(sessionStartKey),
          redis.del(sessionMetaKey),
          redis.del(sessionLogsKey),
          redis.del(trailKey),
          redis.del(startMarkerKey),
        ]);
      } catch (persistErr) {
        // Leave the redis source keys intact so a future retry / restart
        // routine can drain them. The stop signal already went out, so the
        // user-visible state is consistent — only the durable archive is
        // delayed.
        console.error(
          `[stop] background persist failed for ${userId} (sessionId=${dbSessionId ?? 'unassigned'}):`,
          (persistErr as Error).message,
        );
      }
    })();

    return;
  } catch (err) {
    console.error("[POST /:id/stop] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
