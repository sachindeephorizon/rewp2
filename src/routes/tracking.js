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

// In-memory deviation streak counters (per userId). Reset on server restart,
// which is fine — a restart is a natural "reset" event.
const deviationState = new Map(); // userId → { count: number }
const {
  LOCATION_TTL,
  SESSION_TTL,
  TRAIL_MIN_DISTANCE,
  CHANNEL,
  ACTIVE_SET,
} = require("../config");
const { buildStreamMetadata } = require("../utils/stream");

const router = Router();

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
    if (lat < -90 || lat > 90) {
      return res.status(400).json({ error: "lat must be between -90 and 90" });
    }
    if (lng < -180 || lng > 180) {
      return res.status(400).json({ error: "lng must be between -180 and 180" });
    }

    const userAccuracy = typeof accuracy === "number" ? accuracy : null;
    const userTimestamp = typeof timestamp === "number" ? timestamp : null;
    const streamMeta = buildStreamMetadata({
      userId,
      sessionId: req.body.sessionId,
      rideChannel: req.body.rideChannel,
      driverId: req.body.driverId,
    });

    const state = await getUserState(userId);

    if (state.prev && userTimestamp) {
      const gapSeconds = (userTimestamp - state.prev.timestamp) / 1000;
      if (gapSeconds > GAP_RESET_SECONDS) {
        console.log(
          `[ping] Gap of ${gapSeconds.toFixed(0)}s detected for ${userId} - resetting state`
        );
        state.prev = null;
        state.kalman.reset();
        state.filterStreak = 0;
      }
    }

    const processed = processLocation(
      lat,
      lng,
      state.prev,
      state.kalman,
      userAccuracy,
      userTimestamp
    );

    if (!processed) {
      state.filterStreak = (state.filterStreak || 0) + 1;

      if (state.filterStreak >= MAX_FILTER_STREAK) {
        console.warn(
          `[ping] Filter streak ${state.filterStreak} for ${userId} - force resetting state`
        );
        state.prev = null;
        state.kalman.reset();
        state.filterStreak = 0;
        await saveUserState(userId);
      }

      // Even on a filtered ping, tell the phone if an agent wants a fresh fix.
      const pendingReq = await redis.get(`locreq:${userId}`);

      return res.status(200).json({
        ok: true,
        filtered: true,
        reason: "GPS spike rejected",
        streak: state.filterStreak,
        streamKey: streamMeta.streamKey,
        rideChannel: streamMeta.rideChannel,
        sessionId: streamMeta.sessionId,
        forceRefresh: !!pendingReq,
      });
    }

    state.filterStreak = 0;

    const prevState = state.prev;
    const isRealMovement = !prevState
      || prevState.latitude !== processed.latitude
      || prevState.longitude !== processed.longitude;

    state.prev = processed;
    await saveUserState(userId);

    const snapped = isRealMovement
      ? await snapToRoad(processed.latitude, processed.longitude)
      : { lat: processed.latitude, lng: processed.longitude, snapped: false };
    const finalLat = snapped.lat;
    const finalLng = snapped.lng;

    // Compute H3 cell for this location (resolution 9, ~174m hex edge)
    const h3Cell = latLngToH3Cell(finalLat, finalLng, 9);

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
      const lastDot = JSON.parse(lastDotRaw);
      if (haversineDistance(lastDot.lat, lastDot.lng, finalLat, finalLng) >= TRAIL_MIN_DISTANCE) {
        addTrailDot = true;
      }
    }

    const sessionStartedAt = existingSession || now;
    const payload = buildLocationPayload({
      userId,
      streamMeta,
      sessionStartedAt,
      now,
      finalLat,
      finalLng,
      body: req.body,
    });
    payload.h3Cell = h3Cell;

    const locationPoint = JSON.stringify({
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
    });

    const sessionMeta = {
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

    const redisOps = [
      redis.setEx(redisKey, LOCATION_TTL, JSON.stringify(payload)),
      redis.setEx(sessionMetaKey, SESSION_TTL, JSON.stringify(sessionMeta)),
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
          const parsedOldLogs = oldLogs.map((l) => JSON.parse(l));
          const oldSessionStart = new Date(oldStart);
          const oldNow = new Date();
          const oldDuration = Math.floor((oldNow - oldSessionStart) / 1000);
          const countRes = await pool.query(
            "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1",
            [userId]
          );
          const num = parseInt(countRes.rows[0].cnt, 10) + 1;
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
          const oldSid = sResult.rows[0].id;
          const batchSize = 500;
          for (let b = 0; b < parsedOldLogs.length; b += batchSize) {
            const batch = parsedOldLogs.slice(b, b + batchSize);
            const vals = [];
            const params = [];
            batch.forEach((point, index) => {
              const offset = index * 5;
              vals.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5})`);
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

    // ── Deviation detection ─────────────────────────────────────────
    // Only runs when the user has an active destination with corridors.
    // Zone logic:
    //   inner (k=1, ~150m) → SAFE
    //   outer (k=2, ~300m) but not inner → BUFFER (GPS noise, ignore)
    //   outside outer → OUTSIDE → if 3 consecutive → DEVIATED 🚨
    let deviationAlert = null;

    const hasDestination = await redis.exists(`nav:dest:${userId}`);
    if (hasDestination) {
      const inInner = await redis.sIsMember(`nav:inner:${userId}`, h3Cell);

      if (inInner) {
        // Safe — reset streak
        deviationState.set(userId, { count: 0 });
        // If there was an active deviation, mark it resolved
        const activeDevKey = `deviation:${userId}`;
        const activeDev = await redis.get(activeDevKey);
        if (activeDev) {
          await redis.del(activeDevKey);
          // Resolve in DB (best-effort)
          pool.query(
            `UPDATE deviations SET resolved_at = NOW() WHERE user_id = $1 AND resolved_at IS NULL`,
            [userId]
          ).catch(() => {});
        }
      } else {
        const inOuter = await redis.sIsMember(`nav:outer:${userId}`, h3Cell);

        if (inOuter) {
          // Buffer zone — don't increment, don't reset (hysteresis)
          // This absorbs GPS noise at corridor edges
        } else {
          // OUTSIDE — increment streak
          const s = deviationState.get(userId) || { count: 0 };
          s.count++;
          deviationState.set(userId, s);

          if (s.count >= 3) {
            // 🚨 DEVIATED — log to DB, alert dashboard
            const destRaw = await redis.get(`nav:dest:${userId}`);
            const destData = destRaw ? JSON.parse(destRaw) : {};

            // Compute approximate distance from route
            const routeRaw = await redis.get(`nav:route:${userId}`);
            let distFromRoute = null;
            if (routeRaw) {
              const routePts = JSON.parse(routeRaw);
              let minDist = Infinity;
              for (let i = 0; i < routePts.length; i++) {
                const d = haversineDistance(finalLat, finalLng, routePts[i].lat, routePts[i].lng);
                if (d < minDist) minDist = d;
              }
              distFromRoute = Math.round(minDist);
            }

            // Find active session ID in DB (best-effort)
            let dbSessionId = null;
            try {
              const sessionMeta = streamMeta.sessionId;
              if (sessionMeta) {
                const sr = await pool.query(
                  `SELECT id FROM sessions WHERE session_name = $1 ORDER BY id DESC LIMIT 1`,
                  [sessionMeta]
                );
                if (sr.rows.length) dbSessionId = sr.rows[0].id;
              }
            } catch {}

            // Insert deviation record
            try {
              await pool.query(
                `INSERT INTO deviations (user_id, session_id, lat, lng, h3_cell, distance_from_route, zone, consecutive, destination_name)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [userId, dbSessionId, finalLat, finalLng, h3Cell, distFromRoute, 'OUTSIDE', s.count, destData.name || null]
              );
            } catch (e) {
              console.error("[deviation] DB insert failed:", e.message);
            }

            // Store active deviation in Redis for dashboard polling
            const devPayload = {
              userId,
              lat: finalLat,
              lng: finalLng,
              h3Cell,
              distanceFromRoute: distFromRoute,
              consecutive: s.count,
              destinationName: destData.name || null,
              detectedAt: now,
            };
            await redis.set(`deviation:${userId}`, JSON.stringify(devPayload), { EX: SESSION_TTL });

            // Publish deviation alert via the same pub/sub channel
            await redis.publish(CHANNEL, JSON.stringify({
              event: "deviation_alert",
              ...devPayload,
              roomNames: streamMeta.roomNames,
              streamKey: streamMeta.streamKey,
            }));

            deviationAlert = devPayload;
            console.log(`[deviation] 🚨 ${userId} deviated | ${distFromRoute}m from route | streak=${s.count}`);
          }
        }
      }
    }

    // Check for a pending force-location request from an agent.
    const locReqKey = `locreq:${userId}`;
    let forceRefresh = false;

    if (req.body.source === "force_request") {
      await redis.del(locReqKey);
    } else {
      const pending = await redis.get(locReqKey);
      if (pending) forceRefresh = true;
    }

    return res.status(200).json({ ok: true, data: payload, forceRefresh, deviationAlert });
  } catch (err) {
    console.error("[POST /:id/ping] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/stop", async (req, res) => {
  try {
    const userId = req.params.id;
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

    const sessionMeta = sessionMetaRaw ? JSON.parse(sessionMetaRaw) : null;

    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1",
      [userId]
    );
    const sessionNumber = parseInt(countResult.rows[0].cnt, 10) + 1;
    const sessionName = `session${sessionNumber}`;

    const sessionStart = startedAt ? new Date(startedAt) : now;
    const durationSecs = Math.floor((now - sessionStart) / 1000);
    const parsedLogs = logs.map((l) => JSON.parse(l));

    const firstLog = parsedLogs[0];
    const lastLog = parsedLogs[parsedLogs.length - 1];
    const [startLocation, endLocation] = await Promise.all([
      firstLog ? reverseGeocode(firstLog.lat, firstLog.lng) : null,
      lastLog ? reverseGeocode(lastLog.lat, lastLog.lng) : null,
    ]);

    const sessionResult = await pool.query(
      `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings, start_location, end_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [userId, sessionName, sessionStart, now, durationSecs, parsedLogs.length, startLocation, endLocation]
    );
    const dbSessionId = sessionResult.rows[0].id;

    const batchSize = 500;
    for (let b = 0; b < parsedLogs.length; b += batchSize) {
      const batch = parsedLogs.slice(b, b + batchSize);
      const values = [];
      const params = [];
      batch.forEach((point, index) => {
        const offset = index * 5;
        values.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5})`);
        params.push(dbSessionId, point.lat, point.lng, point.h3Cell || null, point.timestamp);
      });
      await pool.query(
        `INSERT INTO location_logs (session_id, lat, lng, h3_cell, recorded_at) VALUES ${values.join(",")}`,
        params
      );
    }

    console.log(`[stop] ${sessionName} | ${parsedLogs.length} pts | ${durationSecs}s`);

    clearUserState(userId);

    const finalLog = parsedLogs[parsedLogs.length - 1];
    const stopMarker = finalLog ? { lat: finalLog.lat, lng: finalLog.lng } : null;
    const startMarker = startMarkerRaw ? JSON.parse(startMarkerRaw) : null;
    const rawTrail = trailDots.map((d) => JSON.parse(d));
    const parsedTrail = rawTrail.length >= 2 ? await snapTrajectory(rawTrail) : rawTrail;

    const stopPayload = {
      event: "tracking_stopped",
      stopped: true,
      userId,
      driverId: sessionMeta?.driverId || userId,
      sessionId: sessionMeta?.sessionId || null,
      streamKey: sessionMeta?.streamKey || `stream:${userId}:live`,
      rideChannel: sessionMeta?.rideChannel || null,
      roomNames: sessionMeta?.roomNames || [],
      timestamp: now.toISOString(),
      endedAt: now.toISOString(),
      totalPings: parsedLogs.length,
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
      redis.sRem(ACTIVE_SET, userId),
      redis.publish(CHANNEL, JSON.stringify(stopPayload)),
    ]);

    return res.status(200).json({
      ok: true,
      session: {
        id: dbSessionId,
        name: sessionName,
        userId,
        startedAt: sessionStart,
        endedAt: now,
        durationSecs,
        totalPings: parsedLogs.length,
        startLocation,
        endLocation,
        startMarker,
        stopMarker,
        trail: parsedTrail,
        stream: sessionMeta,
      },
    });
  } catch (err) {
    console.error("[POST /:id/stop] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
