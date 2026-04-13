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


/**
 * GET /destination/:id/debug-corridor?lat=XX&lng=YY
 *
 * Temporary debug endpoint — remove after fixing deviation.
 * Shows exactly what zone a coordinate falls in and current streak.
 *
 * Example:
 * https://rewp2-production.up.railway.app/destination/sim-driver-1/debug-corridor?lat=26.11978&lng=91.71447
 */
router.get("/:id/debug-corridor", async (req, res) => {
  try {
    const userId = req.params.id;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: "lat and lng query params required" });
    }

    const h3 = require("h3-js");

    // Check at resolution 10 (what corridor is built at)
    const cell10 = h3.latLngToCell(lat, lng, 10);
    // Also check res 9 (old code used this in payload)
    const cell9  = h3.latLngToCell(lat, lng, 9);

    const [
      innerCount,
      outerCount,
      inInner10,
      inOuter10,
      inInner9,
      inOuter9,
      streakRaw,
      destRaw,
    ] = await Promise.all([
      redis.sCard(`nav:inner:${userId}`),
      redis.sCard(`nav:outer:${userId}`),
      redis.sIsMember(`nav:inner:${userId}`, cell10),
      redis.sIsMember(`nav:outer:${userId}`, cell10),
      redis.sIsMember(`nav:inner:${userId}`, cell9),
      redis.sIsMember(`nav:outer:${userId}`, cell9),
      redis.get(`devstreak:${userId}`),
      redis.get(`nav:dest:${userId}`),
    ]);

    const verdict10 = inInner10 ? "SAFE" : inOuter10 ? "BUFFER" : "OUTSIDE ✅ (should trigger deviation)";
    const verdict9  = inInner9  ? "SAFE" : inOuter9  ? "BUFFER" : "OUTSIDE";

    return res.json({
      queried: { lat, lng },
      corridor: {
        innerCellCount: innerCount,
        outerCellCount: outerCount,
        // If outer count is > 5000, corridor is probably still bloated from old code
        likelyBloated: outerCount > 5000,
      },
      resolution10: {
        cell: cell10,
        inInner: inInner10,
        inOuter: inOuter10,
        verdict: verdict10,
      },
      resolution9: {
        cell: cell9,
        inInner: inInner9,
        inOuter: inOuter9,
        verdict: verdict9,
      },
      deviationStreak: streakRaw ? JSON.parse(streakRaw) : { count: 0 },
      destinationActive: !!destRaw,
      diagnosis: innerCount === 0
        ? "❌ NO CORRIDOR IN REDIS — run /destination/:id/set first"
        : outerCount > 5000
          ? "❌ CORRIDOR BLOATED — old h3corridor.js still deployed, clear Redis and redeploy"
          : inOuter10
            ? "❌ POINT INSIDE OUTER CORRIDOR — corridor still too wide, or point not far enough"
            : "✅ POINT IS OUTSIDE — deviation should be firing, check devstreak increment",
    });
  } catch (err) {
    console.error("[debug-corridor]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;