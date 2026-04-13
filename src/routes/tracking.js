const { Router } = require("express");
const { redis } = require("../redis");
const { pool } = require("../db");
const {
  processLocation,
  getUserState,
  saveUserState,
  clearUserState,
  haversineDistance,
  MAX_FILTER_STREAK,
  GAP_RESET_SECONDS,
} = require("../utils/gps");
const { reverseGeocode } = require("../utils/geocode");
const { rateLimitPing } = require("../utils/rateLimit");
const { snapToRoad, snapTrajectory } = require("../utils/snapToRoad");
const { latLngToH3Cell } = require("../utils/h3corridor");

// FIX: Removed in-memory deviationState Map.
// It was resetting on every server restart (Railway free tier sleeps frequently),
// silently zeroing the streak counter mid-simulation and preventing deviation
// alerts from ever reaching 3 consecutive hits.
// Replaced with Redis-backed streak: `devstreak:{userId}` → { count: number }

const {
  LOCATION_TTL,
  SESSION_TTL,
  TRAIL_MIN_DISTANCE,
  CHANNEL,
  ACTIVE_SET,
} = require("../config");
const { buildStreamMetadata } = require("../utils/stream");

const router = Router();

// ── Deviation streak helpers (Redis-backed) ──────────────────────────────────

async function getDeviationStreak(userId) {
  try {
    const raw = await redis.get(`devstreak:${userId}`);
    return raw ? JSON.parse(raw).count : 0;
  } catch {
    return 0;
  }
}

async function setDeviationStreak(userId, count) {
  await redis.set(
    `devstreak:${userId}`,
    JSON.stringify({ count }),
    { EX: SESSION_TTL }
  );
}

async function clearDeviationStreak(userId) {
  await redis.del(`devstreak:${userId}`);
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

const toNullableNumber = (value) => (
  typeof value === "number" && Number.isFinite(value) ? value : null
);

const buildLocationPayload = ({
  userId,
  streamMeta,
  sessionStartedAt,
  now,
  finalLat,
  finalLng,
  body,
}) => ({
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
  sequence: Number.isInteger(body.sequence) ? body.sequence : null,
  gpsIntervalMs: toNullableNumber(body.gpsIntervalMs),
  timestamp: now,
  startedAt: sessionStartedAt,
  roomNames: streamMeta.roomNames,
});

// ── Deviation zone check (shared by filtered + normal ping paths) ─────────────
// FIX: Both paths now use resolution 10 consistently (matches how corridor was built).
// Old code used res=9 for h3Cell in the payload but res=10 for deviation checks —
// confusing and wrong if anything accidentally used the payload cell for corridor lookup.

async function checkDeviation(userId, lat, lng, streamMeta, destData) {
  // FIX: Always use resolution 10 — same resolution used when building nav:inner / nav:outer
  const devCell = latLngToH3Cell(lat, lng, 10);
  const [inInner, inOuter] = await Promise.all([
    redis.sIsMember(`nav:inner:${userId}`, devCell),
    redis.sIsMember(`nav:outer:${userId}`, devCell),
  ]);

  // Zone classification:
  //   inInner → SAFE   (inner is a subset of outer, check inner first)
  //   inOuter (but not inner) → BUFFER (GPS noise margin, ignore)
  //   neither → OUTSIDE → increment streak → alert at 3
  if (inInner) {
    // Back on route — reset streak and resolve any active deviation
    await setDeviationStreak(userId, 0);
    const activeDev = await redis.get(`deviation:${userId}`);
    if (activeDev) {
      await redis.del(`deviation:${userId}`);
      pool.query(
        `UPDATE deviations SET resolved_at = NOW() WHERE user_id = $1 AND resolved_at IS NULL`,
        [userId]
      ).catch(() => {});
    }
    return null; // no alert
  }

  if (inOuter) {
    // Buffer zone — GPS noise, do nothing (no increment, no reset)
    return null;
  }

  // OUTSIDE corridor — increment persistent streak
  const prevCount = await getDeviationStreak(userId);
  const newCount = prevCount + 1;
  await setDeviationStreak(userId, newCount);

  console.log(`[deviation] ${userId} OUTSIDE corridor | streak=${newCount}`);

  if (newCount >= 3) {
    const alert = {
      userId,
      lat,
      lng,
      h3Cell: devCell,
      zone: "OUTSIDE",
      consecutive: newCount,
      destinationName: destData.name || null,
      detectedAt: new Date().toISOString(),
    };

    await redis.set(`deviation:${userId}`, JSON.stringify(alert), { EX: SESSION_TTL });

    await redis.publish(CHANNEL, JSON.stringify({
      event: "deviation_alert",
      ...alert,
      roomNames: streamMeta.roomNames,
      streamKey: streamMeta.streamKey,
    }));

    pool.query(
      `INSERT INTO deviations (user_id, lat, lng, h3_cell, zone, consecutive, destination_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, lat, lng, devCell, "OUTSIDE", newCount, destData.name || null]
    ).catch((e) => console.error("[deviation] DB insert failed:", e.message));

    console.log(`[deviation] 🚨 ${userId} alert fired | streak=${newCount}`);
    return alert;
  }

  return null;
}

// ── Arrival check (shared) ────────────────────────────────────────────────────

const ARRIVAL_RADIUS_M    = 200;
const INACTIVITY_THRESHOLD_S = 900; // 15 minutes

async function checkArrival(userId, lat, lng, destData, streamMeta, now) {
  const distToDest = haversineDistance(lat, lng, destData.destination.lat, destData.destination.lng);
  if (distToDest >= ARRIVAL_RADIUS_M) return false;

  console.log(`[arrival] ✅ ${userId} arrived (${Math.round(distToDest)}m from dest)`);

  await Promise.all([
    redis.del(`nav:dest:${userId}`),
    redis.del(`nav:corridor:${userId}`),
    redis.del(`nav:inner:${userId}`),
    redis.del(`nav:outer:${userId}`),
    redis.del(`nav:route:${userId}`),
    redis.del(`deviation:${userId}`),
    redis.del(`devstreak:${userId}`),   // FIX: also clear Redis-backed streak on arrival
    redis.del(`inactivity:${userId}`),
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

router.post("/:id/ping", rateLimitPing, async (req, res) => {
  try {
    const userId = req.params.id;
    const { lat, lng, accuracy, timestamp } = req.body;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng are required numbers" });
    }
    if (lat < -90 || lat > 90)   return res.status(400).json({ error: "lat must be between -90 and 90" });
    if (lng < -180 || lng > 180) return res.status(400).json({ error: "lng must be between -180 and 180" });

    const userAccuracy  = typeof accuracy  === "number" ? accuracy  : null;
    const userTimestamp = typeof timestamp === "number" ? timestamp : null;

    const streamMeta = buildStreamMetadata({
      userId,
      sessionId:   req.body.sessionId,
      rideChannel: req.body.rideChannel,
      driverId:    req.body.driverId,
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

    const processed = processLocation(
      lat, lng,
      state.prev,
      state.kalman,
      userAccuracy,
      userTimestamp
    );

    // ── FILTERED PING ─────────────────────────────────────────────────────────
    // GPS spike rejected by Kalman / speed / accuracy filter.
    // Still run safety checks on RAW coordinates — safety > smoothness.
    if (!processed) {
      state.filterStreak = (state.filterStreak || 0) + 1;

      if (state.filterStreak >= MAX_FILTER_STREAK) {
        console.warn(`[ping] Filter streak ${state.filterStreak} for ${userId} - force resetting state`);
        state.prev = null;
        state.kalman.reset();
        state.filterStreak = 0;
        await saveUserState(userId);
      }

      let filteredDevAlert = null;
      let filteredArrival  = false;

      const filteredDestRaw = await redis.get(`nav:dest:${userId}`);
      if (filteredDestRaw) {
        const fd = JSON.parse(filteredDestRaw);

        filteredArrival = await checkArrival(userId, lat, lng, fd, streamMeta, null);

        if (!filteredArrival) {
          filteredDevAlert = await checkDeviation(userId, lat, lng, streamMeta, fd);
        }
      }

      const pendingReq = await redis.get(`locreq:${userId}`);

      return res.status(200).json({
        ok: true,
        filtered: true,
        reason: "GPS spike rejected",
        streak: state.filterStreak,
        streamKey:   streamMeta.streamKey,
        rideChannel: streamMeta.rideChannel,
        sessionId:   streamMeta.sessionId,
        forceRefresh: !!pendingReq,
        deviationAlert:  filteredDevAlert,
        arrivalDetected: filteredArrival,
      });
    }

    // ── ACCEPTED PING ─────────────────────────────────────────────────────────

    state.filterStreak = 0;

    const prevState = state.prev;
    const isRealMovement =
      !prevState ||
      prevState.latitude  !== processed.latitude ||
      prevState.longitude !== processed.longitude;

    state.prev = processed;
    await saveUserState(userId);

    const snapped = isRealMovement
      ? await snapToRoad(processed.latitude, processed.longitude)
      : { lat: processed.latitude, lng: processed.longitude, snapped: false };

    const finalLat = snapped.lat;
    const finalLng = snapped.lng;

    // FIX: Use resolution 10 for the payload h3Cell too, consistent with corridor checks.
    // Old code stored res=9 in the payload but used res=10 for deviation — mismatch.
    const h3Cell = latLngToH3Cell(finalLat, finalLng, 10);

    const now = new Date().toISOString();
    const redisKey        = `user:${userId}`;
    const sessionStartKey = `session:${userId}:start`;
    const sessionMetaKey  = `session:${userId}:meta`;
    const sessionLogsKey  = `session:${userId}:logs`;
    const trailKey        = `trail:${userId}`;
    const startMarkerKey  = `marker:${userId}:start`;

    const existingSession = await redis.get(sessionStartKey);
    const isFirstPing = !existingSession;

    let addTrailDot = false;
    const lastDotRaw = await redis.lIndex(trailKey, -1);
    if (!lastDotRaw) {
      addTrailDot = true;
    } else {
      const lastDot = JSON.parse(lastDotRaw);
      if (haversineDistance(lastDot.lat, lastDot.lng, finalLat, finalLng) >= TRAIL_MIN_DISTANCE) {
        addTrailDot = true;
      }
    }

    const sessionStartedAt = existingSession || now;
    const payload = buildLocationPayload({
      userId, streamMeta, sessionStartedAt, now, finalLat, finalLng, body: req.body,
    });
    payload.h3Cell = h3Cell;

    const locationPoint = JSON.stringify({
      lat: finalLat,
      lng: finalLng,
      h3Cell,
      timestamp: now,
      accuracy: payload.accuracy,
      speed:    payload.speed,
      heading:  payload.heading,
      moving:   payload.moving,
      activity: payload.activity,
      source:   payload.source,
      sequence: payload.sequence,
    });

    const sessionMeta = {
      userId,
      driverId:    streamMeta.driverId,
      sessionId:   streamMeta.sessionId,
      streamKey:   streamMeta.streamKey,
      rideChannel: streamMeta.rideChannel,
      roomNames:   streamMeta.roomNames,
      startedAt:   sessionStartedAt,
      latestTimestamp: now,
      appState:    payload.appState,
      source:      payload.source,
      gpsIntervalMs: payload.gpsIntervalMs,
    };

    const redisOps = [
      redis.setEx(redisKey,       LOCATION_TTL, JSON.stringify(payload)),
      redis.setEx(sessionMetaKey, SESSION_TTL,  JSON.stringify(sessionMeta)),
      redis.sAdd(ACTIVE_SET, userId),
    ];

    if (isRealMovement || isFirstPing) {
      redisOps.push(redis.publish(CHANNEL, JSON.stringify(payload)));
    }

    if (isFirstPing) {
      try {
        const [oldStart, oldLogs] = await Promise.all([
          redis.get(sessionStartKey),
          redis.lRange(sessionLogsKey, 0, -1),
        ]);
        if (oldStart && oldLogs && oldLogs.length > 0) {
          const parsedOldLogs  = oldLogs.map((l) => JSON.parse(l));
          const oldSessionStart = new Date(oldStart);
          const oldNow          = new Date();
          const oldDuration     = Math.floor((oldNow - oldSessionStart) / 1000);

          const countRes = await pool.query(
            "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1", [userId]
          );
          const num      = parseInt(countRes.rows[0].cnt, 10) + 1;
          const oldName  = `session${num}`;
          const firstOld = parsedOldLogs[0];
          const lastOld  = parsedOldLogs[parsedOldLogs.length - 1];

          const [startLoc, endLoc] = await Promise.all([
            firstOld ? reverseGeocode(firstOld.lat, firstOld.lng) : null,
            lastOld  ? reverseGeocode(lastOld.lat,  lastOld.lng)  : null,
          ]);

          const sResult = await pool.query(
            `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings, start_location, end_location)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [userId, oldName, oldSessionStart, oldNow, oldDuration, parsedOldLogs.length, startLoc, endLoc]
          );
          const oldSid = sResult.rows[0].id;

          const batchSize = 500;
          for (let b = 0; b < parsedOldLogs.length; b += batchSize) {
            const batch  = parsedOldLogs.slice(b, b + batchSize);
            const vals   = [];
            const params = [];
            batch.forEach((point, index) => {
              const offset = index * 5;
              vals.push(`($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5})`);
              params.push(oldSid, point.lat, point.lng, point.h3Cell || null, point.timestamp);
            });
            await pool.query(
              `INSERT INTO location_logs (session_id, lat, lng, h3_cell, recorded_at) VALUES ${vals.join(",")}`,
              params
            );
          }
          console.log(`[ping] Saved orphan session: ${oldName} | ${parsedOldLogs.length} pts`);
        }
      } catch (e) {
        console.error("[ping] Failed to save orphan session:", e.message);
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

    let deviationAlert  = null;
    let arrivalDetected = false;
    let inactivityFlag  = false;

    const destRaw = await redis.get(`nav:dest:${userId}`);
    if (destRaw) {
      const destData = JSON.parse(destRaw);

      // Use RAW GPS for safety checks — Kalman filter / snap-to-road can mask
      // real deviation by pulling coordinates back toward the route.
      const rawLat = lat;
      const rawLng = lng;

      // Arrival check
      arrivalDetected = await checkArrival(userId, rawLat, rawLng, destData, streamMeta, now);

      if (!arrivalDetected) {
        // Deviation check
        deviationAlert = await checkDeviation(userId, rawLat, rawLng, streamMeta, destData);

        // Inactivity check
        const isMoving  = typeof req.body.moving === "boolean" ? req.body.moving : true;
        const inactKey  = `inactivity:${userId}`;
        const distToDest = haversineDistance(
          rawLat, rawLng,
          destData.destination.lat, destData.destination.lng
        );

        if (!isMoving) {
          const inactRaw = await redis.get(inactKey);
          if (!inactRaw) {
            await redis.set(inactKey, JSON.stringify({ since: now, lat: finalLat, lng: finalLng }), { EX: SESSION_TTL });
          } else {
            const inactData = JSON.parse(inactRaw);
            const stationarySecs = (Date.now() - new Date(inactData.since).getTime()) / 1000;

            if (stationarySecs >= INACTIVITY_THRESHOLD_S && distToDest > ARRIVAL_RADIUS_M * 2) {
              inactivityFlag = true;
              console.log(`[inactivity] ⚠️ ${userId} stationary ${Math.round(stationarySecs)}s`);

              await redis.publish(CHANNEL, JSON.stringify({
                event: "inactivity_alert",
                userId,
                lat: finalLat,
                lng: finalLng,
                stationarySecs: Math.round(stationarySecs),
                since: inactData.since,
                destinationName: destData.name || null,
                timestamp: now,
                roomNames:  streamMeta.roomNames,
                streamKey:  streamMeta.streamKey,
              }));
            }
          }
        } else {
          await redis.del(inactKey);
        }
      }
    }

    // Force-location request handling
    const locReqKey = `locreq:${userId}`;
    let forceRefresh = false;

    if (req.body.source === "force_request") {
      await redis.del(locReqKey);
    } else {
      const pending = await redis.get(locReqKey);
      if (pending) forceRefresh = true;
    }

    return res.status(200).json({
      ok: true,
      data: payload,
      forceRefresh,
      deviationAlert,
      arrivalDetected,
      inactivityFlag,
    });
  } catch (err) {
    console.error("[POST /:id/ping] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── STOP ──────────────────────────────────────────────────────────────────────

router.post("/:id/stop", async (req, res) => {
  try {
    const userId = req.params.id;
    const now    = new Date();

    const sessionStartKey = `session:${userId}:start`;
    const sessionMetaKey  = `session:${userId}:meta`;
    const sessionLogsKey  = `session:${userId}:logs`;
    const trailKey        = `trail:${userId}`;
    const startMarkerKey  = `marker:${userId}:start`;

    const [startedAt, sessionMetaRaw, logs, trailDots, startMarkerRaw] = await Promise.all([
      redis.get(sessionStartKey),
      redis.get(sessionMetaKey),
      redis.lRange(sessionLogsKey, 0, -1),
      redis.lRange(trailKey, 0, -1),
      redis.get(startMarkerKey),
    ]);

    const sessionMeta = sessionMetaRaw ? JSON.parse(sessionMetaRaw) : null;

    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1", [userId]
    );
    const sessionNumber = parseInt(countResult.rows[0].cnt, 10) + 1;
    const sessionName   = `session${sessionNumber}`;

    const sessionStart = startedAt ? new Date(startedAt) : now;
    const durationSecs = Math.floor((now - sessionStart) / 1000);
    const parsedLogs   = logs.map((l) => JSON.parse(l));

    const firstLog = parsedLogs[0];
    const lastLog  = parsedLogs[parsedLogs.length - 1];

    const [startLocation, endLocation] = await Promise.all([
      firstLog ? reverseGeocode(firstLog.lat, firstLog.lng) : null,
      lastLog  ? reverseGeocode(lastLog.lat,  lastLog.lng)  : null,
    ]);

    const sessionResult = await pool.query(
      `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings, start_location, end_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [userId, sessionName, sessionStart, now, durationSecs, parsedLogs.length, startLocation, endLocation]
    );
    const dbSessionId = sessionResult.rows[0].id;

    const batchSize = 500;
    for (let b = 0; b < parsedLogs.length; b += batchSize) {
      const batch  = parsedLogs.slice(b, b + batchSize);
      const values = [];
      const params = [];
      batch.forEach((point, index) => {
        const offset = index * 5;
        values.push(`($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5})`);
        params.push(dbSessionId, point.lat, point.lng, point.h3Cell || null, point.timestamp);
      });
      await pool.query(
        `INSERT INTO location_logs (session_id, lat, lng, h3_cell, recorded_at) VALUES ${values.join(",")}`,
        params
      );
    }

    console.log(`[stop] ${sessionName} | ${parsedLogs.length} pts | ${durationSecs}s`);

    clearUserState(userId);

    const finalLog   = parsedLogs[parsedLogs.length - 1];
    const stopMarker = finalLog ? { lat: finalLog.lat, lng: finalLog.lng } : null;
    const startMarker = startMarkerRaw ? JSON.parse(startMarkerRaw) : null;
    const rawTrail   = trailDots.map((d) => JSON.parse(d));
    const parsedTrail = rawTrail.length >= 2 ? await snapTrajectory(rawTrail) : rawTrail;

    const stopPayload = {
      event:       "tracking_stopped",
      stopped:     true,
      userId,
      driverId:    sessionMeta?.driverId    || userId,
      sessionId:   sessionMeta?.sessionId   || null,
      streamKey:   sessionMeta?.streamKey   || `stream:${userId}:live`,
      rideChannel: sessionMeta?.rideChannel || null,
      roomNames:   sessionMeta?.roomNames   || [],
      timestamp:   now.toISOString(),
      endedAt:     now.toISOString(),
      totalPings:  parsedLogs.length,
      durationSecs,
    };

    await Promise.all([
      redis.del(`user:${userId}`),
      redis.del(sessionStartKey),
      redis.del(sessionMetaKey),
      redis.del(sessionLogsKey),
      redis.del(trailKey),
      redis.del(startMarkerKey),
      redis.del(`nav:dest:${userId}`),
      redis.del(`nav:corridor:${userId}`),
      redis.del(`nav:inner:${userId}`),
      redis.del(`nav:outer:${userId}`),
      redis.del(`nav:route:${userId}`),
      redis.del(`deviation:${userId}`),
      redis.del(`devstreak:${userId}`),   // FIX: clean up Redis streak on stop
      redis.sRem(ACTIVE_SET, userId),
      redis.publish(CHANNEL, JSON.stringify(stopPayload)),
    ]);

    return res.status(200).json({
      ok: true,
      session: {
        id:           dbSessionId,
        name:         sessionName,
        userId,
        startedAt:    sessionStart,
        endedAt:      now,
        durationSecs,
        totalPings:   parsedLogs.length,
        startLocation,
        endLocation,
        startMarker,
        stopMarker,
        trail:        parsedTrail,
        stream:       sessionMeta,
      },
    });
  } catch (err) {
    console.error("[POST /:id/stop] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;