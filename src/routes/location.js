const { Router } = require("express");
const { redis } = require("../redis");
const { pool } = require("../db");
const { processLocation, getUserState, clearUserState, haversineDistance } = require("../gps");
const { rateLimitPing } = require("../rateLimit");
const router = Router();

// FIX: TTL raised from 60s → 300s (5 min)
// With 1s pings this is fine, but gives a buffer for background/offline gaps
const LOCATION_TTL = 300;

// FIX: Session key TTL — prevents Redis memory filling up with unbounded log lists
// With 1s pings you generate ~3600 entries/hour. Without TTL, long sessions OOM Redis.
const SESSION_TTL = 86400; // 24 hours

const TRAIL_MIN_DISTANCE = 5; // meters — minimum distance between trail dots

const CHANNEL = "location_updates";
const ACTIVE_SET = "active_users";

// ── POST /:id/ping ──────────────────────────────────────────────────

router.post("/:id/ping", rateLimitPing, async (req, res) => {
  try {
    const userId = req.params.id;
    const { lat, lng, speed, accuracy, timestamp } = req.body;
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

    const userSpeed = typeof speed === "number" ? speed : null;
    const userAccuracy = typeof accuracy === "number" ? accuracy : null;
    const userTimestamp = typeof timestamp === "number" ? timestamp : null;

    // ── GPS filtering ──────────────────────────────────────────────
    const state = getUserState(userId);
    // FIX: pass state as last argument so gps.js uses per-user smoothing
    const processed = processLocation(lat, lng, userSpeed, state.prev, state.kalman, userAccuracy, userTimestamp, userId, state);

    if (!processed) {
      // Rejected as noise/spike — don't store or broadcast
      return res.status(200).json({ ok: true, filtered: true, reason: "GPS spike rejected" });
    }

    const isFirstPing = !state.prev;
    state.prev = processed;

    const now = new Date().toISOString();
    const redisKey = `user:${userId}`;
    const sessionStartKey = `session:${userId}:start`;
    const sessionLogsKey = `session:${userId}:logs`;
    const trailKey = `trail:${userId}`;
    const startMarkerKey = `marker:${userId}:start`;

    // ── Trail dot logic (only when moving, min distance apart) ────
    let addTrailDot = false;
    if (processed.speed > 0.5) {
      const lastDotRaw = await redis.lIndex(trailKey, -1);
      if (!lastDotRaw) {
        addTrailDot = true;
      } else {
        const lastDot = JSON.parse(lastDotRaw);
        const d = haversineDistance(lastDot.lat, lastDot.lng, processed.latitude, processed.longitude);
        if (d >= TRAIL_MIN_DISTANCE) addTrailDot = true;
      }
    }

    const payload = {
      userId,
      lat: processed.latitude,
      lng: processed.longitude,
      speed: processed.speed,
      bearing: processed.bearing,
      activity: processed.activity,
      timestamp: now,
    };

    const locationPoint = JSON.stringify({
      lat: processed.latitude,
      lng: processed.longitude,
      speed: processed.speed,
      activity: processed.activity,
      timestamp: now,
    });

    const redisOps = [
      redis.setEx(redisKey, LOCATION_TTL, JSON.stringify(payload)),
      redis.sAdd(ACTIVE_SET, userId),
      redis.publish(CHANNEL, JSON.stringify(payload)),
      redis.set(sessionStartKey, now, { NX: true }),
      redis.rPush(sessionLogsKey, locationPoint),
      // FIX: Set TTL on session keys to prevent unbounded Redis memory growth.
      // 1s pings = ~3600 entries/hour. Without TTL, long sessions fill Redis → 500 errors.
      redis.expire(sessionLogsKey, SESSION_TTL),
      redis.expire(trailKey, SESSION_TTL),
      redis.expire(sessionStartKey, SESSION_TTL),
    ];

    // Store start marker on first ping
    if (isFirstPing) {
      const startMarker = JSON.stringify({ lat: processed.latitude, lng: processed.longitude, timestamp: now });
      redisOps.push(redis.set(startMarkerKey, startMarker));
      redisOps.push(redis.expire(startMarkerKey, SESSION_TTL));
    }

    // Store trail dot
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

    // FIX: Compute avg/max speed from filtered speed values stored in Redis logs.
    // Previously these were never calculated — sessions table had no speed columns.
    // Only include moving points (speed > 0.5 m/s) so stationary time doesn't
    // drag avg speed down to near-zero, matching frontend behavior.
    const movingPoints = parsedLogs.filter(p => typeof p.speed === 'number' && p.speed > 0.5);
    const maxSpeed = movingPoints.length > 0
      ? Math.max(...movingPoints.map(p => p.speed))
      : 0;
    const avgSpeed = movingPoints.length > 0
      ? movingPoints.reduce((sum, p) => sum + p.speed, 0) / movingPoints.length
      : 0;
    // Convert m/s → km/h, round to 2 decimal places
    const maxSpeedKmh = Math.round(maxSpeed * 3.6 * 100) / 100;
    const avgSpeedKmh = Math.round(avgSpeed * 3.6 * 100) / 100;

    const sessionResult = await pool.query(
      `INSERT INTO sessions (user_id, session_name, started_at, ended_at, duration_secs, total_pings, avg_speed_kmh, max_speed_kmh)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [userId, sessionName, sessionStart, now, durationSecs, parsedLogs.length, avgSpeedKmh, maxSpeedKmh]
    );
    const sessionId = sessionResult.rows[0].id;

    // Bulk insert in batches of 500 to avoid query size limits
    const BATCH_SIZE = 500;
    for (let b = 0; b < parsedLogs.length; b += BATCH_SIZE) {
      const batch = parsedLogs.slice(b, b + BATCH_SIZE);
      const values = [];
      const params = [];
      batch.forEach((point, i) => {
        const offset = i * 5;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        params.push(sessionId, point.lat, point.lng, point.speed ?? null, point.timestamp);
      });
      await pool.query(
        `INSERT INTO location_logs (session_id, lat, lng, speed, recorded_at) VALUES ${values.join(", ")}`,
        params
      );
    }

    console.log(
      `[POST /${userId}/stop] Flushed: ${sessionName} | ${parsedLogs.length} points | ${durationSecs}s`
    );

    // Clear GPS filter state for this user
    clearUserState(userId);

    // Build stop marker
    const lastLog = parsedLogs[parsedLogs.length - 1];
    const stopMarker = lastLog ? { lat: lastLog.lat, lng: lastLog.lng } : null;
    const startMarker = startMarkerRaw ? JSON.parse(startMarkerRaw) : null;
    const parsedTrail = trailDots.map((d) => JSON.parse(d));

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
        avgSpeedKmh,
        maxSpeedKmh,
        startMarker,
        stopMarker,
        trail: parsedTrail,
      },
    });
  } catch (err) {
    console.error("[POST /:id/stop] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /users/active ────────────────────────────────────────────────

router.get("/users/active", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const cursor = req.query.cursor || "0";

    // FIX: node-redis v4 sScan returns { cursor, members } object, NOT an array.
    // Destructuring as array throws "is not iterable". Use object destructuring instead.
    const scanResult = await redis.sScan(ACTIVE_SET, cursor, { COUNT: limit });
    const nextCursor = scanResult.cursor;
    const userIds = scanResult.members;

    if (userIds.length === 0) {
      return res.status(200).json({ ok: true, data: [], cursor: "0", hasMore: false });
    }

    const keys = userIds.map((id) => `user:${id}`);
    const values = await redis.mGet(keys);

    const users = [];
    const staleIds = [];

    for (let i = 0; i < userIds.length; i++) {
      if (values[i]) {
        users.push(JSON.parse(values[i]));
      } else {
        staleIds.push(userIds[i]);
      }
    }

    if (staleIds.length > 0) {
      redis.sRem(ACTIVE_SET, staleIds).catch(() => {});
    }

    const total = await redis.sCard(ACTIVE_SET);

    return res.status(200).json({
      ok: true,
      data: users,
      total,
      cursor: nextCursor,
      hasMore: String(nextCursor) !== "0",
    });
  } catch (err) {
    console.error("[GET /users/active] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /sessions/all ────────────────────────────────────────────────

router.get("/sessions/all", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions"),
      pool.query(
        `SELECT id, user_id, session_name, started_at, ended_at, duration_secs, total_pings, avg_speed_kmh, max_speed_kmh, created_at
         FROM sessions ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /sessions/all] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id ───────────────────────────────────────────────────

router.get("/user/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const raw = await redis.get(`user:${id}`);
    if (!raw) {
      return res.status(404).json({ error: "No location found for this user" });
    }
    return res.status(200).json({ ok: true, data: JSON.parse(raw) });
  } catch (err) {
    console.error("[GET /user/:id] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/trail ──────────────────────────────────────────────

router.get("/user/:id/trail", async (req, res) => {
  try {
    const { id } = req.params;
    const [trailDots, startMarkerRaw] = await Promise.all([
      redis.lRange(`trail:${id}`, 0, -1),
      redis.get(`marker:${id}:start`),
    ]);

    return res.status(200).json({
      ok: true,
      startMarker: startMarkerRaw ? JSON.parse(startMarkerRaw) : null,
      trail: trailDots.map((d) => JSON.parse(d)),
    });
  } catch (err) {
    console.error("[GET /user/:id/trail] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/sessions ──────────────────────────────────────────

router.get("/user/:id/sessions", async (req, res) => {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions WHERE user_id = $1", [id]),
      pool.query(
        `SELECT id, session_name, started_at, ended_at, duration_secs, total_pings, avg_speed_kmh, max_speed_kmh, created_at
         FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /user/:id/sessions] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /session/:sessionId/logs ────────────────────────────────────

router.get("/session/:sessionId/logs", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const offset = (page - 1) * limit;

    const sid = parseInt(sessionId, 10);

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM location_logs WHERE session_id = $1", [sid]),
      pool.query(
        `SELECT lat, lng, speed, recorded_at FROM location_logs
         WHERE session_id = $1 ORDER BY recorded_at ASC LIMIT $2 OFFSET $3`,
        [sid, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /session/:id/logs] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;