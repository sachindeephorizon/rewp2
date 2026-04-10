const { Router } = require("express");
const { redis } = require("../redis");
const { haversineDistance } = require("../utils/gps");
const { ACTIVE_SET } = require("../config");

const router = Router();

router.get("/active", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const cursor = req.query.cursor || "0";

    const scanResult = await redis.sScan(ACTIVE_SET, cursor, { COUNT: limit });
    const nextCursor = scanResult.cursor;
    const userIds = scanResult.members;

    if (userIds.length === 0) {
      return res.status(200).json({ ok: true, data: [], cursor: "0", hasMore: false });
    }

    const locationKeys = userIds.map((id) => `user:${id}`);
    const sessionKeys = userIds.map((id) => `session:${id}:start`);
    const metaKeys = userIds.map((id) => `session:${id}:meta`);

    const [locationValues, sessionValues, metaValues] = await Promise.all([
      redis.mGet(locationKeys),
      redis.mGet(sessionKeys),
      redis.mGet(metaKeys),
    ]);

    const users = [];
    const staleIds = [];

    for (let i = 0; i < userIds.length; i++) {
      const hasLocation = !!locationValues[i];
      const hasSession = !!sessionValues[i];
      const meta = metaValues[i] ? JSON.parse(metaValues[i]) : null;

      if (hasLocation) {
        users.push({
          ...JSON.parse(locationValues[i]),
          sessionMeta: meta,
        });
      } else if (hasSession) {
        users.push({
          userId: userIds[i],
          lat: null,
          lng: null,
          timestamp: null,
          startedAt: sessionValues[i],
          sessionMeta: meta,
          stale: true,
        });
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

router.get("/:id/stream", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const [rawLocation, trailDots, startMarkerRaw, sessionStartedAt, sessionMetaRaw] = await Promise.all([
      redis.get(`user:${id}`),
      redis.lRange(`trail:${id}`, 0, -1),
      redis.get(`marker:${id}:start`),
      redis.get(`session:${id}:start`),
      redis.get(`session:${id}:meta`),
    ]);

    if (!rawLocation && !sessionStartedAt) {
      return res.status(404).json({ error: "No active stream found for this user" });
    }

    const location = rawLocation ? JSON.parse(rawLocation) : null;
    const sessionMeta = sessionMetaRaw ? JSON.parse(sessionMetaRaw) : null;

    return res.status(200).json({
      ok: true,
      data: location,
      sessionMeta,
      startedAt: sessionStartedAt,
      startMarker: startMarkerRaw ? JSON.parse(startMarkerRaw) : null,
      trail: trailDots.map((dot) => JSON.parse(dot)),
    });
  } catch (err) {
    console.error("[GET /user/:id/stream] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
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

router.get("/:id/trail", async (req, res) => {
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

router.get("/:id/session-distance", async (req, res) => {
  try {
    const { id } = req.params;
    const logs = await redis.lRange(`session:${id}:logs`, 0, -1);

    if (!logs || logs.length < 2) {
      return res.status(200).json({ ok: true, distance: 0, points: logs ? logs.length : 0 });
    }

    let totalDistance = 0;
    let prev = JSON.parse(logs[0]);

    for (let i = 1; i < logs.length; i += 1) {
      const curr = JSON.parse(logs[i]);
      const d = haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);
      if (d < 100) {
        totalDistance += d;
      }
      prev = curr;
    }

    return res.status(200).json({ ok: true, distance: totalDistance, points: logs.length });
  } catch (err) {
    console.error("[GET /user/:id/session-distance] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Force location request — agent asks the phone to send a fresh GPS fix.
//
// Flow:
//   1. Agent calls  POST /user/:id/request-location
//      → sets Redis key  locreq:${id}  with TTL 120s
//      → returns last known location immediately (may be stale)
//   2. Phone detects the request via:
//      a) The ping response includes  forceRefresh: true  (see tracking.js)
//      b) Phone polls  GET /user/:id/request-location  every 30s as fallback
//   3. Phone grabs a fresh GPS fix and sends a ping with source "force_request"
//   4. That ping clears the Redis key automatically (see tracking.js)
// ──────────────────────────────────────────────────────────────────────────────
const LOCREQ_TTL = 120; // seconds — auto-expire if phone never responds

router.post("/:id/request-location", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }

    // Store the request flag.
    await redis.set(`locreq:${id}`, JSON.stringify({
      requestedAt: new Date().toISOString(),
      requestedBy: req.body?.agentId || "unknown",
    }), { EX: LOCREQ_TTL });

    // Return last known location immediately so the agent has *something*.
    const raw = await redis.get(`user:${id}`);
    const lastKnown = raw ? JSON.parse(raw) : null;

    return res.status(200).json({
      ok: true,
      pending: true,
      message: "Location request sent. Phone will respond within ~30 seconds.",
      lastKnown,
    });
  } catch (err) {
    console.error("[POST /user/:id/request-location] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/request-location", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const raw = await redis.get(`locreq:${id}`);
    if (!raw) {
      return res.status(200).json({ ok: true, pending: false });
    }

    return res.status(200).json({ ok: true, pending: true, ...JSON.parse(raw) });
  } catch (err) {
    console.error("[GET /user/:id/request-location] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
