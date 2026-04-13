"use strict";

const { Router } = require("express");
const { redis } = require("../redis");
const { SESSION_TTL } = require("../config");
const { fetchOsrmRoute } = require("../utils/osrmRoute");
const h3 = require("h3-js");
const { buildH3Corridor } = require("../utils/h3corridor");

const router = Router();

// Redis key helpers
const destKey      = (userId) => `nav:dest:${userId}`;
const corridorKey  = (userId) => `nav:corridor:${userId}`;  // dashboard viz only
const innerKey     = (userId) => `nav:inner:${userId}`;      // SAFE zone  — O(1) sIsMember
const outerKey     = (userId) => `nav:outer:${userId}`;      // BUFFER zone — O(1) sIsMember
const routeKey     = (userId) => `nav:route:${userId}`;

/**
 * POST /destination/:id/set
 *
 * Dual-corridor design (resolution 10, edge ≈ 65m):
 *
 *   INNER  buffer=1 → ~130m from route centre  → SAFE   (on route)
 *   OUTER  buffer=2 → ~260m from route centre  → BUFFER (GPS noise)
 *   Beyond outer                               → OUTSIDE → 3 consecutive = DEVIATED 🚨
 *
 * FIX (was buffer=1/2 but MAX_GAP_M=50 caused corridors to blob-merge,
 * wiping out the OUTSIDE zone entirely).  The real fix is in h3corridor.js
 * (MAX_GAP_M 50→30), but we also keep buffers explicitly documented here
 * so they're easy to tune.
 */
router.post("/:id/set", async (req, res) => {
  try {
    const userId = req.params.id;
    const { origin, destination } = req.body;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (
      !origin      || typeof origin.lat      !== "number" || typeof origin.lng      !== "number" ||
      !destination || typeof destination.lat !== "number" || typeof destination.lng !== "number"
    ) {
      return res.status(400).json({ error: "origin and destination must have lat/lng numbers" });
    }

    // 1. Fetch OSRM route
    const { route, distance, duration } = await fetchOsrmRoute(origin, destination);

    // 2. Build dual H3 corridors at resolution 10
    //    Inner  (k=1) → ~130m  — SAFE zone, no deviation counter increment
    //    Outer  (k=2) → ~260m  — BUFFER zone, ignore (GPS noise)
    //    Outside both → OUTSIDE zone, 3 consecutive pings → deviation alert
    //
    //    NOTE: outerCells is a superset of innerCells by definition (k=2 ⊃ k=1).
    //    The ping handler checks inner FIRST, then outer, so a cell that is in both
    //    is correctly classified as SAFE, not BUFFER.
    const innerCells = buildH3Corridor(route, { resolution: 10, buffer: 1 });
    const outerCells = buildH3Corridor(route, { resolution: 10, buffer: 2 });

    console.log(
      `[destination] ${userId} → ${destination.lat.toFixed(4)},${destination.lng.toFixed(4)} | ` +
      `${route.length} pts | inner=${innerCells.length} outer=${outerCells.length} h3 cells | ` +
      `${(distance / 1000).toFixed(1)}km`
    );

    // 3. Store in Redis
    const destData = {
      origin,
      destination,
      name: req.body.name || null,
      distance,
      duration,
      setAt: new Date().toISOString(),
    };

    // Clear previous corridor sets first (avoids stale cells from old routes)
    await Promise.all([
      redis.del(innerKey(userId)),
      redis.del(outerKey(userId)),
    ]);

    await Promise.all([
      redis.set(destKey(userId),     JSON.stringify(destData),   { EX: SESSION_TTL }),
      redis.set(corridorKey(userId), JSON.stringify(outerCells), { EX: SESSION_TTL }), // dashboard viz
      redis.set(routeKey(userId),    JSON.stringify(route),      { EX: SESSION_TTL }),
      innerCells.length > 0 ? redis.sAdd(innerKey(userId), innerCells) : Promise.resolve(),
      outerCells.length > 0 ? redis.sAdd(outerKey(userId), outerCells) : Promise.resolve(),
    ]);

    await Promise.all([
      redis.expire(innerKey(userId), SESSION_TTL),
      redis.expire(outerKey(userId), SESSION_TTL),
    ]);

    // 4. Return only what the phone needs
    return res.status(200).json({
      ok: true,
      distance,
      duration,
      routePoints: route.length,
    });
  } catch (err) {
    console.error("[POST /destination/:id/set] Error:", err.message);
    return res.status(500).json({ error: "Route computation failed", detail: err.message });
  }
});

/**
 * POST /destination/:id/clear
 */
router.post("/:id/clear", async (req, res) => {
  try {
    const userId = req.params.id;
    await Promise.all([
      redis.del(destKey(userId)),
      redis.del(corridorKey(userId)),
      redis.del(innerKey(userId)),
      redis.del(outerKey(userId)),
      redis.del(routeKey(userId)),
    ]);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[POST /destination/:id/clear] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /destination/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const raw = await redis.get(destKey(userId));
    if (!raw) {
      return res.status(200).json({ ok: true, active: false });
    }

    const dest = JSON.parse(raw);

    let route = null;
    let corridor = null;

    if (req.query.includeRoute === "true") {
      const routeRaw = await redis.get(routeKey(userId));
      if (routeRaw) route = JSON.parse(routeRaw);
    }

    if (req.query.includeCorridor === "true") {
      const corridorRaw = await redis.get(corridorKey(userId));
      if (corridorRaw) {
        const cells = JSON.parse(corridorRaw);
        const features = cells.map((cellIndex) => {
          const boundary = h3.cellToBoundary(cellIndex);
          const ring = boundary.map(([lat, lng]) => [lng, lat]);
          ring.push(ring[0]);
          return {
            type: "Feature",
            properties: { h3: cellIndex },
            geometry: { type: "Polygon", coordinates: [ring] },
          };
        });
        corridor = { type: "FeatureCollection", features };
      }
    }

    return res.status(200).json({
      ok: true,
      active: true,
      destination: dest.destination,
      name: dest.name,
      distance: dest.distance,
      duration: dest.duration,
      setAt: dest.setAt,
      route,
      corridor,
    });
  } catch (err) {
    console.error("[GET /destination/:id] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /destination/:id/remaining
 */
router.get("/:id/remaining", async (req, res) => {
  try {
    const userId = req.params.id;
    const [destRaw, routeRaw, locRaw] = await Promise.all([
      redis.get(destKey(userId)),
      redis.get(routeKey(userId)),
      redis.get(`user:${userId}`),
    ]);

    if (!destRaw) {
      return res.status(200).json({ ok: true, active: false });
    }

    const dest = JSON.parse(destRaw);
    const loc  = locRaw ? JSON.parse(locRaw) : null;

    if (!loc || !routeRaw) {
      return res.status(200).json({
        ok: true,
        active: true,
        remaining: dest.distance,
        destination: dest.destination,
        name: dest.name,
      });
    }

    const route = JSON.parse(routeRaw);
    const { haversineDistance } = require("../utils/gps");

    let minDist = Infinity, minIdx = 0;
    for (let i = 0; i < route.length; i++) {
      const d = haversineDistance(loc.lat, loc.lng, route[i].lat, route[i].lng);
      if (d < minDist) { minDist = d; minIdx = i; }
    }

    let remaining = 0;
    for (let i = minIdx; i < route.length - 1; i++) {
      remaining += haversineDistance(
        route[i].lat, route[i].lng,
        route[i + 1].lat, route[i + 1].lng
      );
    }

    return res.status(200).json({
      ok: true,
      active: true,
      remaining: Math.round(remaining),
      destination: dest.destination,
      name: dest.name,
    });
  } catch (err) {
    console.error("[GET /destination/:id/remaining] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;