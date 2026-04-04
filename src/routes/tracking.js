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

// ═══════════════════════════════════════════════════════════════════
//  Helper: get or create active session for a user.
//  Checks Redis first, falls back to PostgreSQL, creates if none.
//  Returns sessionId (string).
// ═══════════════════════════════════════════════════════════════════
async function getOrCreateSession(userId, sessionIdKey, sessionStartKey, trailKey, startMarkerKey, finalLat, finalLng, now) {
  // 1. Check Redis cache
  let sessionId = await redis.get(sessionIdKey);
  if (sessionId) {
    // Refresh TTL so keys don't expire during active session
    await Promise.all([
      redis.expire(sessionIdKey, SESSION_TTL),
      redis.expire(sessionStartKey, SESSION_TTL),
    ]);
    return { sessionId, isNew: false };
  }

  // 2. Redis miss — check PostgreSQL for active session
  const activeResult = await pool.query(
    "SELECT id, started_at FROM sessions WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [userId]
  );

  if (activeResult.rows.length > 0) {
    // Active session exists — restore Redis keys
    sessionId = String(activeResult.rows[0].id);
    const startTime = activeResult.rows[0].started_at.toISOString();
    await Promise.all([
      redis.set(sessionIdKey, sessionId),
      redis.expire(sessionIdKey, SESSION_TTL),
      redis.set(sessionStartKey, startTime),
      redis.expire(sessionStartKey, SESSION_TTL),
    ]);
    console.log(`[ping] Restored session ${sessionId} from PG for ${userId}`);
    return { sessionId, isNew: false };
  }

  // 3. No active session anywhere — close orphans and create new one
  await pool.query(
    `UPDATE sessions SET is_active = false, ended_at = $1,
       duration_secs = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int
     WHERE user_id = $2 AND is_active = true`,
    [now, userId]
  );

  const countResult = await pool.query(
    "SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = $1",
    [userId]
  );
  const num = parseInt(countResult.rows[0].cnt, 10) + 1;
  const sessionName = `session${num}`;

  const sessionResult = await pool.query(
    `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings, is_active)
     VALUES ($1, $2, $3, NULL, 0, 0, true)
     RETURNING id`,
    [userId, sessionName, now]
  );
  sessionId = String(sessionResult.rows[0].id);

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
  return { sessionId, isNew: true };
}

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
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "lat/lng out of range" });
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

    const snapped = isRealMovement
      ? await snapToRoad(processed.latitude, processed.longitude)
      : { lat: processed.latitude, lng: processed.longitude, snapped: false };
    const finalLat = snapped.lat;
    const finalLng = snapped.lng;

    const now = new Date().toISOString();
    const redisKey = `user:${userId}`;
    const sessionIdKey = `session:${userId}:id`;
    const sessionStartKey = `session:${userId}:start`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    // Get or create active session (no duplicate sessions)
    const { sessionId, isNew } = await getOrCreateSession(
      userId, sessionIdKey, sessionStartKey, trailKey, startMarkerKey, finalLat, finalLng, now
    );

    // XADD to Redis Stream → worker inserts into PostgreSQL
    await redis.xAdd(STREAM_NAME, "*", {
      userId,
      sessionId,
      lat: String(finalLat),
      lng: String(finalLng),
      accuracy: String(userAccuracy || 0),
      ts: now,
    });

    // Real-time: SET + PUBLISH
    const payload = { userId, lat: finalLat, lng: finalLng, timestamp: now };

    const redisOps = [
      redis.setEx(redisKey, LOCATION_TTL, JSON.stringify(payload)),
      redis.sAdd(ACTIVE_SET, userId),
    ];

    if (isRealMovement || isNew) {
      redisOps.push(redis.publish(CHANNEL, JSON.stringify(payload)));
    }

    // Trail dots
    const lastDotRaw = await redis.lIndex(trailKey, -1);
    let addTrailDot = !lastDotRaw;
    if (!addTrailDot) {
      const lastDot = JSON.parse(lastDotRaw);
      addTrailDot = haversineDistance(lastDot.lat, lastDot.lng, finalLat, finalLng) >= TRAIL_MIN_DISTANCE;
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
// Finalizes the session: is_active → false, fill ended_at, geocode, cleanup.

router.post("/:id/stop", async (req, res) => {
  try {
    const userId = req.params.id;
    const now = new Date();
    const sessionIdKey = `session:${userId}:id`;
    const sessionStartKey = `session:${userId}:start`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    // Get session ID from Redis or PG
    let sessionId = await redis.get(sessionIdKey);
    if (!sessionId) {
      const activeResult = await pool.query(
        "SELECT id FROM sessions WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
        [userId]
      );
      if (activeResult.rows.length > 0) {
        sessionId = String(activeResult.rows[0].id);
      }
    }

    if (!sessionId) {
      return res.status(200).json({ ok: true, message: "No active session" });
    }

    const sid = parseInt(sessionId, 10);
    const startedAt = await redis.get(sessionStartKey);
    const sessionStart = startedAt ? new Date(startedAt) : now;
    const durationSecs = Math.floor((now - sessionStart) / 1000);

    // Count logs the worker has inserted
    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM location_logs WHERE session_id = $1",
      [sid]
    );
    const totalPings = parseInt(countResult.rows[0].cnt, 10);

    // Get first and last log for geocoding
    const [firstLogResult, lastLogResult] = await Promise.all([
      pool.query("SELECT lat, lng FROM location_logs WHERE session_id = $1 ORDER BY recorded_at ASC LIMIT 1", [sid]),
      pool.query("SELECT lat, lng FROM location_logs WHERE session_id = $1 ORDER BY recorded_at DESC LIMIT 1", [sid]),
    ]);

    const firstLog = firstLogResult.rows[0];
    const lastLog = lastLogResult.rows[0];

    const [startLocation, endLocation] = await Promise.all([
      firstLog ? reverseGeocode(firstLog.lat, firstLog.lng) : null,
      lastLog ? reverseGeocode(lastLog.lat, lastLog.lng) : null,
    ]);

    // Finalize session: is_active = false
    await pool.query(
      `UPDATE sessions
       SET is_active = false, ended_at = $1, duration_secs = $2, total_pings = $3,
           start_location = $4, end_location = $5
       WHERE id = $6`,
      [now, durationSecs, totalPings, startLocation, endLocation, sid]
    );

    console.log(`[POST /${userId}/stop] Finalized: session ${sid} | ${totalPings} points | ${durationSecs}s`);

    clearUserState(userId);

    const stopMarker = lastLog ? { lat: lastLog.lat, lng: lastLog.lng } : null;

    const [trailDots, startMarkerRaw] = await Promise.all([
      redis.lRange(trailKey, 0, -1),
      redis.get(startMarkerKey),
    ]);
    const rawTrail = trailDots.map((d) => JSON.parse(d));
    const parsedTrail = rawTrail.length >= 2 ? await snapTrajectory(rawTrail) : rawTrail;
    const startMarker = startMarkerRaw ? JSON.parse(startMarkerRaw) : null;

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
        startMarker: startMarkerParsed, stopMarker,
        trail: parsedTrail,
      },
    });
  } catch (err) {
    console.error("[POST /:id/stop] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
