const { Router } = require("express");
const { redis } = require("../redis");
const { pool } = require("../db");
const { processLocation, getUserState, clearUserState, haversineDistance } = require("../utils/gps");
const { reverseGeocode } = require("../utils/geocode");
const { rateLimitPing } = require("../utils/rateLimit");
const { snapToRoad, snapTrajectory } = require("../utils/snapToRoad");
const {
  LOCATION_TTL, SESSION_TTL, TRAIL_MIN_DISTANCE,
  CHANNEL, ACTIVE_SET, STREAM_NAME,
} = require("../config");

const router = Router();

// ── POST /:id/ping ──────────────────────────────────────────────────
// Real-time: SET + PUBLISH (unchanged)
// Logging:   XADD to Redis Stream (replaces RPUSH)
// Session:   Created in PostgreSQL on first ping (not on stop)

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

    const prevState = state.prev;
    const isRealMovement = !prevState ||
      prevState.latitude !== processed.latitude ||
      prevState.longitude !== processed.longitude;

    state.prev = processed;

    // Road snap
    const snapped = isRealMovement
      ? await snapToRoad(processed.latitude, processed.longitude)
      : { lat: processed.latitude, lng: processed.longitude, snapped: false };
    const finalLat = snapped.lat;
    const finalLng = snapped.lng;

    const now = new Date().toISOString();
    const redisKey = `user:${userId}`;
    const sessionIdKey = `session:${userId}:id`;       // PG session ID
    const sessionStartKey = `session:${userId}:start`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    // Check if active session exists
    let sessionId = await redis.get(sessionIdKey);
    const isFirstPing = !sessionId;

    // ── First ping: create session in PostgreSQL ──
    if (isFirstPing) {
      // Save any orphan session from previous crash
      const oldSessionId = await redis.get(sessionIdKey);
      if (oldSessionId) {
        try {
          await pool.query(
            `UPDATE sessions SET ended_at = $1, duration_secs = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int
             WHERE id = $2 AND ended_at IS NULL`,
            [now, parseInt(oldSessionId, 10)]
          );
        } catch {}
      }

      // Count existing sessions for naming
      const countResult = await pool.query(
        "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1",
        [userId]
      );
      const num = parseInt(countResult.rows[0].cnt, 10) + 1;
      const sessionName = `session${num}`;

      // Create active session (ended_at = NULL)
      const sessionResult = await pool.query(
        `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings)
         VALUES ($1, $2, $3, NULL, 0, 0)
         RETURNING id`,
        [userId, sessionName, now]
      );
      sessionId = String(sessionResult.rows[0].id);

      // Store session ID + start time in Redis
      await Promise.all([
        redis.set(sessionIdKey, sessionId),
        redis.expire(sessionIdKey, SESSION_TTL),
        redis.set(sessionStartKey, now),
        redis.expire(sessionStartKey, SESSION_TTL),
        redis.del(trailKey),
        redis.set(startMarkerKey, JSON.stringify({ lat: finalLat, lng: finalLng, timestamp: now })),
        redis.expire(startMarkerKey, SESSION_TTL),
      ]);

      console.log(`[ping] New session: ${sessionName} (id=${sessionId}) for ${userId}`);
    }

    // ── XADD to Redis Stream (replaces RPUSH) ──
    await redis.xAdd(STREAM_NAME, "*", {
      userId,
      sessionId,
      lat: String(finalLat),
      lng: String(finalLng),
      accuracy: String(userAccuracy || 0),
      ts: now,
    });

    // ── Real-time: SET + PUBLISH (unchanged) ──
    const payload = {
      userId,
      lat: finalLat,
      lng: finalLng,
      timestamp: now,
    };

    const redisOps = [
      redis.setEx(redisKey, LOCATION_TTL, JSON.stringify(payload)),
      redis.sAdd(ACTIVE_SET, userId),
    ];

    if (isRealMovement || isFirstPing) {
      redisOps.push(redis.publish(CHANNEL, JSON.stringify(payload)));
    }

    // Trail dots
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

    if (addTrailDot) {
      redisOps.push(redis.rPush(trailKey, JSON.stringify({ lat: finalLat, lng: finalLng, timestamp: now })));
      redisOps.push(redis.expire(trailKey, SESSION_TTL));
    }

    await Promise.all(redisOps);

    return res.status(200).json({ ok: true, data: payload });
  } catch (err) {
    console.error("[POST /:id/ping] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /:id/stop ──────────────────────────────────────────────────
// With streams, location_logs are already in PostgreSQL (inserted by worker).
// Stop just finalizes the session record + cleans up Redis.

router.post("/:id/stop", async (req, res) => {
  try {
    const userId = req.params.id;
    const now = new Date();
    const sessionIdKey = `session:${userId}:id`;
    const sessionStartKey = `session:${userId}:start`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    const [sessionId, startedAt, trailDots, startMarkerRaw] = await Promise.all([
      redis.get(sessionIdKey),
      redis.get(sessionStartKey),
      redis.lRange(trailKey, 0, -1),
      redis.get(startMarkerKey),
    ]);

    if (!sessionId) {
      return res.status(200).json({ ok: true, message: "No active session" });
    }

    const sid = parseInt(sessionId, 10);
    const sessionStart = startedAt ? new Date(startedAt) : now;
    const durationSecs = Math.floor((now - sessionStart) / 1000);

    // Count how many logs the worker has inserted for this session
    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM location_logs WHERE session_id = $1",
      [sid]
    );
    const totalPings = parseInt(countResult.rows[0].cnt, 10);

    // Get first and last log for geocoding
    const [firstLogResult, lastLogResult] = await Promise.all([
      pool.query(
        "SELECT lat, lng FROM location_logs WHERE session_id = $1 ORDER BY recorded_at ASC LIMIT 1",
        [sid]
      ),
      pool.query(
        "SELECT lat, lng FROM location_logs WHERE session_id = $1 ORDER BY recorded_at DESC LIMIT 1",
        [sid]
      ),
    ]);

    const firstLog = firstLogResult.rows[0];
    const lastLog = lastLogResult.rows[0];

    const [startLocation, endLocation] = await Promise.all([
      firstLog ? reverseGeocode(firstLog.lat, firstLog.lng) : null,
      lastLog ? reverseGeocode(lastLog.lat, lastLog.lng) : null,
    ]);

    // Finalize the session — update ended_at, duration, pings, locations
    await pool.query(
      `UPDATE sessions
       SET ended_at = $1, duration_secs = $2, total_pings = $3,
           start_location = $4, end_location = $5
       WHERE id = $6`,
      [now, durationSecs, totalPings, startLocation, endLocation, sid]
    );

    console.log(
      `[POST /${userId}/stop] Finalized: session ${sid} | ${totalPings} points | ${durationSecs}s`
    );

    clearUserState(userId);

    const stopMarker = lastLog ? { lat: lastLog.lat, lng: lastLog.lng } : null;
    const startMarker = startMarkerRaw ? JSON.parse(startMarkerRaw) : null;
    const rawTrail = trailDots.map((d) => JSON.parse(d));

    const parsedTrail = rawTrail.length >= 2
      ? await snapTrajectory(rawTrail)
      : rawTrail;

    // Clean up Redis
    await Promise.all([
      redis.del(`user:${userId}`),
      redis.del(sessionIdKey),
      redis.del(sessionStartKey),
      redis.del(trailKey),
      redis.del(startMarkerKey),
      redis.sRem(ACTIVE_SET, userId),
      redis.publish(CHANNEL, JSON.stringify({ userId, stopped: true })),
    ]);

    return res.status(200).json({
      ok: true,
      session: {
        id: sid, userId,
        startedAt: sessionStart, endedAt: now,
        durationSecs, totalPings,
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
