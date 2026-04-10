"use strict";

const { Router } = require("express");
const { redis } = require("../redis");
const { SESSION_TTL } = require("../config");
const { fetchOsrmRoute } = require("../utils/osrmRoute");
const h3 = require("h3-js");
const { buildH3Corridor } = require("../utils/h3corridor");

const router = Router();

// Redis key helpers
const destKey = (userId) => `nav:dest:${userId}`;
const corridorKey = (userId) => `nav:corridor:${userId}`;
const routeKey = (userId) => `nav:route:${userId}`;

/**
 * POST /destination/:id/set
 *
 * Called by the phone when the user picks a destination.
 * 1. Fetches OSRM driving route from origin → destination
 * 2. Builds H3 corridor cells (res 9, k=1 ring ≈ 500m width)
 * 3. Stores destination, route, and corridor in Redis
 * 4. Returns distance + duration to the phone (no route/h3 details)
 */
router.post("/:id/set", async (req, res) => {
  try {
    const userId = req.params.id;
    const { origin, destination } = req.body;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (
      !origin || typeof origin.lat !== "number" || typeof origin.lng !== "number" ||
      !destination || typeof destination.lat !== "number" || typeof destination.lng !== "number"
    ) {
      return res.status(400).json({ error: "origin and destination must have lat/lng numbers" });
    }

    // 1. Fetch OSRM route
    const { route, distance, duration } = await fetchOsrmRoute(origin, destination);

    // 2. Build H3 corridor (runs in <50ms for typical city routes)
    const corridorCells = buildH3Corridor(route, 9);
    const corridorSet = corridorCells; // store as array, phone never sees it

    // 3. Store in Redis with session-level TTL
    const destData = {
      origin,
      destination,
      name: req.body.name || null,
      distance,
      duration,
      setAt: new Date().toISOString(),
    };

    await Promise.all([
      redis.set(destKey(userId), JSON.stringify(destData), { EX: SESSION_TTL }),
      redis.set(corridorKey(userId), JSON.stringify(corridorSet), { EX: SESSION_TTL }),
      redis.set(routeKey(userId), JSON.stringify(route), { EX: SESSION_TTL }),
    ]);

    console.log(
      `[destination] ${userId} → ${destination.lat.toFixed(4)},${destination.lng.toFixed(4)} | ` +
      `${route.length} pts | ${corridorCells.length} h3 cells | ${(distance / 1000).toFixed(1)}km`
    );

    // 4. Return only what the phone needs — distance + duration
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
 *
 * Called when the user clears their destination or arrives.
 */
router.post("/:id/clear", async (req, res) => {
  try {
    const userId = req.params.id;
    await Promise.all([
      redis.del(destKey(userId)),
      redis.del(corridorKey(userId)),
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
 *
 * Returns current destination info + remaining distance.
 * Called by the phone to check distance-left, and by the dashboard to show the route.
 */
router.get("/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const raw = await redis.get(destKey(userId));
    if (!raw) {
      return res.status(200).json({ ok: true, active: false });
    }

    const dest = JSON.parse(raw);

    // Dashboard can request the full route and/or H3 corridor for display
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
        // Convert H3 indices to GeoJSON FeatureCollection so the dashboard
        // doesn't need h3-js (WASM issues in Next.js).
        const features = cells.map((cellIndex) => {
          const boundary = h3.cellToBoundary(cellIndex); // [[lat,lng], ...]
          const ring = boundary.map(([lat, lng]) => [lng, lat]);
          ring.push(ring[0]); // close the ring
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
 *
 * Computes distance remaining from user's current location to destination
 * using the stored route + their latest ping position.
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
    const loc = locRaw ? JSON.parse(locRaw) : null;

    if (!loc || !routeRaw) {
      return res.status(200).json({
        ok: true,
        active: true,
        remaining: dest.distance,
        destination: dest.destination,
        name: dest.name,
      });
    }

    // Simple remaining calc: sum haversine from nearest route point onward
    const route = JSON.parse(routeRaw);
    const { haversineDistance } = require("../utils/gps");

    let minDist = Infinity, minIdx = 0;
    for (let i = 0; i < route.length; i++) {
      const d = haversineDistance(loc.lat, loc.lng, route[i].lat, route[i].lng);
      if (d < minDist) { minDist = d; minIdx = i; }
    }

    let remaining = 0;
    for (let i = minIdx; i < route.length - 1; i++) {
      remaining += haversineDistance(route[i].lat, route[i].lng, route[i + 1].lat, route[i + 1].lng);
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
