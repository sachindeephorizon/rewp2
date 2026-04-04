const { Router } = require("express");
const { redis } = require("../redis");
const { pool } = require("../db");
const { processLocation, getUserState, clearUserState, haversineDistance } = require("../utils/gps");
const { reverseGeocode } = require("../utils/geocode");
const { rateLimitPing } = require("../utils/rateLimit");
const { snapToRoad, snapTrajectory } = require("../utils/snapToRoad");
const { LOCATION_TTL, SESSION_TTL, TRAIL_MIN_DISTANCE, CHANNEL, ACTIVE_SET } = require("../config");

const router = Router();

// ── POST /:id/ping ──────────────────────────────────────────────────

router.post("/:id/ping", rateLimitPing, async (req, res) => {
  try {
    const userId = req.params.id;
    const { lat, lng, accuracy, timestamp } = req.body;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng are required and must be numbers" });
    }
    if (lat < -90 || lat > 90) {
      return res.status(400).json({ error: "lat must be between -90 and 90" });
    }
    if (lng < -180 || lng > 180) {
      return res.status(400).json({ error: "lng must be between -180 and 180" });
    }

    const userAccuracy = typeof accuracy === "number" ? accuracy : null;
    const userTimestamp = typeof timestamp === "number" ? timestamp : null;

    const state = getUserState(userId);
    const processed = processLocation(lat, lng, state.prev, state.kalman, userAccuracy, userTimestamp);

    if (!processed) {
      return res.status(200).json({ ok: true, filtered: true, reason: "GPS spike rejected" });
    }

    // Detect real movement — if position unchanged from previous, it's stationary
    const prevState = state.prev;
    const isRealMovement = !prevState ||
      prevState.latitude !== processed.latitude ||
      prevState.longitude !== processed.longitude;

    state.prev = processed;

    // Road snap — snap processed coordinates to nearest road (non-blocking)
    const snapped = isRealMovement
      ? await snapToRoad(processed.latitude, processed.longitude)
      : { lat: processed.latitude, lng: processed.longitude, snapped: false };
    const finalLat = snapped.lat;
    const finalLng = snapped.lng;

    const now = new Date().toISOString();
    const redisKey = `user:${userId}`;
    const sessionStartKey = `session:${userId}:start`;
    const sessionLogsKey = `session:${userId}:logs`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    // Check if this user already has an active session in Redis
    // (survives server restarts — in-memory GPS state doesn't)
    const existingSession = await redis.get(sessionStartKey);
    const isFirstPing = !existingSession;

    // Trail dot — only add if moved enough since last dot
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

    // existingSession = start time for continuing session, now for new session
    const sessionStartedAt = existingSession || now;

    const payload = {
      userId,
      lat: finalLat,
      lng: finalLng,
      timestamp: now,
      startedAt: sessionStartedAt,
    };

    const locationPoint = JSON.stringify({
      lat: finalLat,
      lng: finalLng,
      timestamp: now,
    });

    const redisOps = [
      redis.setEx(redisKey, LOCATION_TTL, JSON.stringify(payload)),
      redis.sAdd(ACTIVE_SET, userId),
    ];

    // Only emit to dashboard when there's real movement or first ping
    if (isRealMovement || isFirstPing) {
      redisOps.push(redis.publish(CHANNEL, JSON.stringify(payload)));
    }

    if (isFirstPing) {
      // If there's leftover session data from a previous session that was
      // never stopped (e.g. server restarted, app crashed), save it to DB
      // before clearing so it's not lost.
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
          const countRes = await pool.query("SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1", [userId]);
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [userId, oldName, oldSessionStart, oldNow, oldDuration, parsedOldLogs.length, startLoc, endLoc]
          );
          const oldSid = sResult.rows[0].id;
          const BATCH = 500;
          for (let b = 0; b < parsedOldLogs.length; b += BATCH) {
            const batch = parsedOldLogs.slice(b, b + BATCH);
            const vals = [], params = [];
            batch.forEach((p, i) => {
              const o = i * 4;
              vals.push(`($${o+1},$${o+2},$${o+3},$${o+4})`);
              params.push(oldSid, p.lat, p.lng, p.timestamp);
            });
            await pool.query(`INSERT INTO location_logs (session_id, lat, lng, recorded_at) VALUES ${vals.join(",")}`, params);
          }
          console.log(`[ping] Auto-saved orphan session: ${oldName} | ${parsedOldLogs.length} pts`);
        }
      } catch (e) {
        console.error("[ping] Failed to save orphan session:", e.message);
      }

      // Now clear and start fresh
      redisOps.push(redis.del(sessionLogsKey));
      redisOps.push(redis.del(trailKey));
      redisOps.push(redis.set(sessionStartKey, now));
      redisOps.push(redis.expire(sessionStartKey, SESSION_TTL));
      redisOps.push(redis.rPush(sessionLogsKey, locationPoint));
      redisOps.push(redis.expire(sessionLogsKey, SESSION_TTL));
      const startMarker = JSON.stringify({ lat: processed.latitude, lng: processed.longitude, timestamp: now });
      redisOps.push(redis.set(startMarkerKey, startMarker));
      redisOps.push(redis.expire(startMarkerKey, SESSION_TTL));
    } else {
      redisOps.push(redis.rPush(sessionLogsKey, locationPoint));
      redisOps.push(redis.expire(sessionLogsKey, SESSION_TTL));
      redisOps.push(redis.expire(trailKey, SESSION_TTL));
    }

    if (addTrailDot) {
      const trailDot = JSON.stringify({ lat: processed.latitude, lng: processed.longitude, timestamp: now });
      redisOps.push(redis.rPush(trailKey, trailDot));
    }

    await Promise.all(redisOps);

    return res.status(200).json({ ok: true, data: payload });
  } catch (err) {
    console.error("[POST /:id/ping] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /:id/stop ──────────────────────────────────────────────────

router.post("/:id/stop", async (req, res) => {
  try {
    const userId = req.params.id;
    const now = new Date();
    const sessionStartKey = `session:${userId}:start`;
    const sessionLogsKey = `session:${userId}:logs`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    const [startedAt, logs, trailDots, startMarkerRaw] = await Promise.all([
      redis.get(sessionStartKey),
      redis.lRange(sessionLogsKey, 0, -1),
      redis.lRange(trailKey, 0, -1),
      redis.get(startMarkerKey),
    ]);

    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1",
      [userId]
    );
    const sessionNumber = parseInt(countResult.rows[0].cnt, 10) + 1;
    const sessionName = `session${sessionNumber}`;

    const sessionStart = startedAt ? new Date(startedAt) : now;
    const durationSecs = Math.floor((now - sessionStart) / 1000);
    const parsedLogs = logs.map((l) => JSON.parse(l));

    // Geocode start and end locations
    const firstLog = parsedLogs[0];
    const lastLog = parsedLogs[parsedLogs.length - 1];
    const [startLocation, endLocation] = await Promise.all([
      firstLog ? reverseGeocode(firstLog.lat, firstLog.lng) : null,
      lastLog ? reverseGeocode(lastLog.lat, lastLog.lng) : null,
    ]);

    const sessionResult = await pool.query(
      `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings, start_location, end_location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [userId, sessionName, sessionStart, now, durationSecs, parsedLogs.length, startLocation, endLocation]
    );
    const sessionId = sessionResult.rows[0].id;

    // Bulk insert location logs
    const BATCH_SIZE = 500;
    for (let b = 0; b < parsedLogs.length; b += BATCH_SIZE) {
      const batch = parsedLogs.slice(b, b + BATCH_SIZE);
      const values = [];
      const params = [];
      batch.forEach((point, i) => {
        const offset = i * 4;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
        params.push(sessionId, point.lat, point.lng, point.timestamp);
      });
      await pool.query(
        `INSERT INTO location_logs (session_id, lat, lng, recorded_at) VALUES ${values.join(", ")}`,
        params
      );
    }

    console.log(
      `[POST /${userId}/stop] Flushed: ${sessionName} | ${parsedLogs.length} points | ${durationSecs}s`
    );

    clearUserState(userId);

    const finalLog = parsedLogs[parsedLogs.length - 1];
    const stopMarker = finalLog ? { lat: finalLog.lat, lng: finalLog.lng } : null;
    const startMarker = startMarkerRaw ? JSON.parse(startMarkerRaw) : null;
    const rawTrail = trailDots.map((d) => JSON.parse(d));

    // Snap entire trail to roads for smooth playback
    const parsedTrail = rawTrail.length >= 2
      ? await snapTrajectory(rawTrail)
      : rawTrail;

    await Promise.all([
      redis.del(`user:${userId}`),
      redis.del(sessionStartKey),
      redis.del(sessionLogsKey),
      redis.del(trailKey),
      redis.del(startMarkerKey),
      redis.sRem(ACTIVE_SET, userId),
      redis.publish(CHANNEL, JSON.stringify({ userId, stopped: true })),
    ]);

    return res.status(200).json({
      ok: true,
      session: {
        id: sessionId, name: sessionName, userId,
        startedAt: sessionStart, endedAt: now,
        durationSecs, totalPings: parsedLogs.length,
        startLocation, endLocation,
        startMarker, stopMarker,
        trail: parsedTrail,
      },
    });
  } catch (err) {
    console.error("[POST /:id/stop] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
