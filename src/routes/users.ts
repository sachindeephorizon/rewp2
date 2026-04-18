import { Router, type Request, type Response } from "express";
import { redis } from "../redis";
import { haversineDistance } from "../utils/gps";
import { ACTIVE_SET } from "../config";

const router = Router();

router.get("/active", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const cursor = parseInt((req.query.cursor as string) || "0", 10);

    const scanResult = await redis.sScan(ACTIVE_SET, cursor, { COUNT: limit });
    const nextCursor = scanResult.cursor;
    const userIds = scanResult.members;

    if (userIds.length === 0) {
      res.status(200).json({ ok: true, data: [], cursor: "0", hasMore: false });
      return;
    }

    const locationKeys = userIds.map((id) => `user:${id}`);
    const sessionKeys = userIds.map((id) => `session:${id}:start`);
    const metaKeys = userIds.map((id) => `session:${id}:meta`);

    const [locationValues, sessionValues, metaValues] = await Promise.all([
      redis.mGet(locationKeys),
      redis.mGet(sessionKeys),
      redis.mGet(metaKeys),
    ]);

    const users: Record<string, unknown>[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < userIds.length; i++) {
      const hasLocation = !!locationValues[i];
      const hasSession = !!sessionValues[i];
      const meta = metaValues[i] ? JSON.parse(metaValues[i]!) : null;

      if (hasLocation) {
        users.push({
          ...JSON.parse(locationValues[i]!),
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

    res.status(200).json({
      ok: true,
      data: users,
      total,
      cursor: nextCursor,
      hasMore: String(nextCursor) !== "0",
    });
  } catch (err) {
    console.error("[GET /users/active] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/stream", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    const [rawLocation, trailDots, startMarkerRaw, sessionStartedAt, sessionMetaRaw] = await Promise.all([
      redis.get(`user:${id}`),
      redis.lRange(`trail:${id}`, 0, -1),
      redis.get(`marker:${id}:start`),
      redis.get(`session:${id}:start`),
      redis.get(`session:${id}:meta`),
    ]);

    if (!rawLocation && !sessionStartedAt) {
      res.status(404).json({ error: "No active stream found for this user" });
      return;
    }

    const location = rawLocation ? JSON.parse(rawLocation) : null;
    const sessionMeta = sessionMetaRaw ? JSON.parse(sessionMetaRaw) : null;

    res.status(200).json({
      ok: true,
      data: location,
      sessionMeta,
      startedAt: sessionStartedAt,
      startMarker: startMarkerRaw ? JSON.parse(startMarkerRaw) : null,
      trail: trailDots.map((dot) => JSON.parse(dot)),
    });
  } catch (err) {
    console.error("[GET /user/:id/stream] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const raw = await redis.get(`user:${id}`);
    if (!raw) {
      res.status(404).json({ error: "No location found for this user" });
      return;
    }
    res.status(200).json({ ok: true, data: JSON.parse(raw) });
  } catch (err) {
    console.error("[GET /user/:id] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/trail", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [trailDots, startMarkerRaw] = await Promise.all([
      redis.lRange(`trail:${id}`, 0, -1),
      redis.get(`marker:${id}:start`),
    ]);

    res.status(200).json({
      ok: true,
      startMarker: startMarkerRaw ? JSON.parse(startMarkerRaw) : null,
      trail: trailDots.map((d) => JSON.parse(d)),
    });
  } catch (err) {
    console.error("[GET /user/:id/trail] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/session-distance", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const logs = await redis.lRange(`session:${id}:logs`, 0, -1);

    if (!logs || logs.length < 2) {
      res.status(200).json({ ok: true, distance: 0, points: logs ? logs.length : 0 });
      return;
    }

    let totalDistance = 0;
    let prev = JSON.parse(logs[0]) as { lat: number; lng: number };

    for (let i = 1; i < logs.length; i += 1) {
      const curr = JSON.parse(logs[i]) as { lat: number; lng: number };
      const d = haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);
      if (d < 100) {
        totalDistance += d;
      }
      prev = curr;
    }

    res.status(200).json({ ok: true, distance: totalDistance, points: logs.length });
  } catch (err) {
    console.error("[GET /user/:id/session-distance] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Force location request
// ──────────────────────────────────────────────────────────────────────────────
const LOCREQ_TTL = 120;

router.post("/:id/request-location", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    await redis.set(`locreq:${id}`, JSON.stringify({
      requestedAt: new Date().toISOString(),
      requestedBy: (req.body as { agentId?: string })?.agentId || "unknown",
    }), { EX: LOCREQ_TTL });

    const raw = await redis.get(`user:${id}`);
    const lastKnown = raw ? JSON.parse(raw) : null;

    res.status(200).json({
      ok: true,
      pending: true,
      message: "Location request sent. Phone will respond within ~30 seconds.",
      lastKnown,
    });
  } catch (err) {
    console.error("[POST /user/:id/request-location] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/request-location", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    const raw = await redis.get(`locreq:${id}`);
    if (!raw) {
      res.status(200).json({ ok: true, pending: false });
      return;
    }

    res.status(200).json({ ok: true, pending: true, ...JSON.parse(raw) });
  } catch (err) {
    console.error("[GET /user/:id/request-location] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
