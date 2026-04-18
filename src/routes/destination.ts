import { Router, type Request, type Response } from "express";
import { redis } from "../redis";
import { SESSION_TTL, CHANNEL } from "../config";
import { fetchOsrmRoute } from "../utils/osrmRoute";
import { pool } from "../db";
import * as h3 from "h3-js";
import { buildH3Corridor } from "../utils/h3corridor";
import { haversineDistance } from "../utils/gps";
import type { LatLng, DestinationData } from "../types";

const router = Router();

// Redis key helpers
const destKey = (userId: string) => `nav:dest:${userId}`;
const corridorKey = (userId: string) => `nav:corridor:${userId}`;
const innerKey = (userId: string) => `nav:inner:${userId}`;
const outerKey = (userId: string) => `nav:outer:${userId}`;
const routeKey = (userId: string) => `nav:route:${userId}`;

/**
 * POST /destination/:id/set
 */
router.post("/:id/set", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id as string;
    const { origin, destination } = req.body as {
      origin?: LatLng;
      destination?: LatLng;
      name?: string;
    };

    if (!userId || typeof userId !== "string") {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    if (
      !origin || typeof origin.lat !== "number" || typeof origin.lng !== "number" ||
      !destination || typeof destination.lat !== "number" || typeof destination.lng !== "number"
    ) {
      res.status(400).json({ error: "origin and destination must have lat/lng numbers" });
      return;
    }

    // 1. Fetch OSRM route
    const { route, distance, duration } = await fetchOsrmRoute(origin, destination);

    // 2. Build dual H3 corridors at resolution 10
    const innerCells = buildH3Corridor(route, { resolution: 10, buffer: 0 });
    const outerCells = buildH3Corridor(route, { resolution: 10, buffer: 1 });

    console.log(
      `[destination] ${userId} → ${destination.lat.toFixed(4)},${destination.lng.toFixed(4)} | ` +
      `${route.length} pts | inner=${innerCells.length} outer=${outerCells.length} h3 cells | ` +
      `${(distance / 1000).toFixed(1)}km`
    );

    // 3. Store in Redis
    const destData: DestinationData = {
      origin,
      destination,
      name: (req.body as { name?: string }).name || null,
      distance,
      duration,
      routePointCount: route.length,
      innerCellCount: innerCells.length,
      outerCellCount: outerCells.length,
      setAt: new Date().toISOString(),
    };

    await Promise.all([
      redis.del(innerKey(userId)),
      redis.del(outerKey(userId)),
    ]);

    await Promise.all([
      redis.set(destKey(userId), JSON.stringify(destData), { EX: SESSION_TTL }),
      redis.set(corridorKey(userId), JSON.stringify(outerCells), { EX: SESSION_TTL }),
      redis.set(routeKey(userId), JSON.stringify(route), { EX: SESSION_TTL }),
      innerCells.length > 0 ? redis.sAdd(innerKey(userId), innerCells) : Promise.resolve(),
      outerCells.length > 0 ? redis.sAdd(outerKey(userId), outerCells) : Promise.resolve(),
    ]);

    await Promise.all([
      redis.expire(innerKey(userId), SESSION_TTL),
      redis.expire(outerKey(userId), SESSION_TTL),
    ]);

    // 4. Log destination_set event
    pool.query(
      `INSERT INTO session_events (user_id, event_type, lat, lng, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, 'destination_set', destination.lat, destination.lng, JSON.stringify({
        name: (req.body as { name?: string }).name || null,
        origin,
        destination,
        distance,
        duration,
        routePoints: route.length,
        innerCells: innerCells.length,
        outerCells: outerCells.length,
      })]
    ).catch((e: Error) => console.error("[destination_set] event log failed:", e.message));

    // 5. Return only what the phone needs
    res.status(200).json({
      ok: true,
      distance,
      duration,
      routePoints: route.length,
    });
  } catch (err) {
    console.error("[POST /destination/:id/set] Error:", (err as Error).message);
    res.status(500).json({ error: "Route computation failed", detail: (err as Error).message });
  }
});

/**
 * POST /destination/:id/clear
 */
router.post("/:id/clear", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id as string;
    await Promise.all([
      redis.del(destKey(userId)),
      redis.del(corridorKey(userId)),
      redis.del(innerKey(userId)),
      redis.del(outerKey(userId)),
      redis.del(routeKey(userId)),
    ]);
    pool.query(
      `INSERT INTO session_events (user_id, event_type) VALUES ($1, $2)`,
      [userId, 'destination_cleared']
    ).catch(() => {});
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[POST /destination/:id/clear] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /destination/:id
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id as string;
    const raw = await redis.get(destKey(userId));
    if (!raw) {
      res.status(200).json({ ok: true, active: false });
      return;
    }

    const dest = JSON.parse(raw) as DestinationData;

    let route: LatLng[] | null = null;
    let corridor: { type: string; features: unknown[] } | null = null;

    if (req.query.includeRoute === "true") {
      const routeRaw = await redis.get(routeKey(userId));
      if (routeRaw) route = JSON.parse(routeRaw) as LatLng[];
    }

    if (req.query.includeCorridor === "true") {
      const corridorRaw = await redis.get(corridorKey(userId));
      if (corridorRaw) {
        const cells = JSON.parse(corridorRaw) as string[];
        const features = cells.map((cellIndex) => {
          const boundary = h3.cellToBoundary(cellIndex);
          const ring: [number, number][] = boundary.map(([lat, lng]) => [lng, lat]);
          ring.push(ring[0]);
          return {
            type: "Feature" as const,
            properties: { h3: cellIndex },
            geometry: { type: "Polygon" as const, coordinates: [ring] },
          };
        });
        corridor = { type: "FeatureCollection", features };
      }
    }

    res.status(200).json({
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
    console.error("[GET /destination/:id] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /destination/:id/remaining
 */
router.get("/:id/remaining", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id as string;
    const [destRaw, routeRaw, locRaw] = await Promise.all([
      redis.get(destKey(userId)),
      redis.get(routeKey(userId)),
      redis.get(`user:${userId}`),
    ]);

    if (!destRaw) {
      res.status(200).json({ ok: true, active: false });
      return;
    }

    const dest = JSON.parse(destRaw) as DestinationData;
    const loc = locRaw ? JSON.parse(locRaw) as { lat: number; lng: number } : null;

    if (!loc || !routeRaw) {
      res.status(200).json({
        ok: true,
        active: true,
        remaining: dest.distance,
        destination: dest.destination,
        name: dest.name,
      });
      return;
    }

    const route = JSON.parse(routeRaw) as LatLng[];

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

    res.status(200).json({
      ok: true,
      active: true,
      remaining: Math.round(remaining),
      destination: dest.destination,
      name: dest.name,
    });
  } catch (err) {
    console.error("[GET /destination/:id/remaining] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
