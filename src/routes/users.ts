import { Router, type Request, type Response } from "express";
import { redis } from "../redis";
import { haversineDistance } from "../utils/gps";
import { ACTIVE_SET } from "../config";

const router = Router();

async function loadFallbackActiveUserIds(limit: number): Promise<string[]> {
  const ids = new Set<string>();
  for await (const key of redis.scanIterator({
    MATCH: "session:*:start",
    COUNT: Math.max(limit, 100),
  })) {
    const parts = String(key).split(":");
    if (parts.length >= 3 && parts[0] === "session" && parts[parts.length - 1] === "start") {
      const userId = parts.slice(1, -1).join(":");
      if (userId) ids.add(userId);
    }
    if (ids.size >= limit) break;
  }
  return Array.from(ids);
}

/**
 * Drop any userId that has a live `stopped:{id}` flag set.
 *
 * The /stop handler stamps `stopped:{id}` with a 5-min TTL. While it's set,
 * the user must NOT appear in /active even if leftover redis keys (e.g.
 * `session:{id}:start` still pending background DB persist) would
 * otherwise resurrect them via the fallback scan. Without this guard the
 * dashboard shows a "stale" user-shaped row for several seconds — or
 * indefinitely if the DB persist fails.
 *
 * Side-effect: every stopped userId we find still in ACTIVE_SET gets
 * sRem'd here, so the next call doesn't repeat the same work.
 */
async function filterOutStoppedUsers(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return userIds;
  const stoppedFlags = await Promise.all(
    userIds.map((id) => redis.get(`stopped:${id}`)),
  );
  const stoppedIds: string[] = [];
  const live: string[] = [];
  for (let i = 0; i < userIds.length; i++) {
    if (stoppedFlags[i]) stoppedIds.push(userIds[i]);
    else live.push(userIds[i]);
  }
  if (stoppedIds.length > 0) {
    redis.sRem(ACTIVE_SET, stoppedIds).catch(() => {});
  }
  return live;
}

router.get("/active", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const cursor = parseInt((req.query.cursor as string) || "0", 10);

    const scanResult = await redis.sScan(ACTIVE_SET, cursor, { COUNT: limit });
    let nextCursor = scanResult.cursor;
    let userIds = scanResult.members;

    // Fallback source of truth: live session keys.
    // This prevents empty responses when ACTIVE_SET was lost (e.g. Redis restart).
    if (userIds.length === 0) {
      const fallbackUserIds = await loadFallbackActiveUserIds(limit);
      if (fallbackUserIds.length > 0) {
        // Filter BEFORE re-adding to ACTIVE_SET — otherwise stopped users
        // come back to life every time someone polls /active.
        const liveFallback = await filterOutStoppedUsers(fallbackUserIds);
        if (liveFallback.length > 0) {
          userIds = liveFallback;
          nextCursor = 0;
          redis.sAdd(ACTIVE_SET, liveFallback).catch(() => {});
        }
      }
    } else {
      // Even on the primary path, drop any userId whose `stopped:` flag is
      // set. The /stop handler clears ACTIVE_SET, but any in-flight ping
      // that races the stop can briefly re-add the user before /ping's
      // own stopped-flag guard kicks in.
      userIds = await filterOutStoppedUsers(userIds);
    }

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
        // Session-start exists but no live `user:{id}` location key. After
        // /stop, `user:{id}` is cleared in Phase 1 and `session:{id}:start`
        // is cleared in Phase 3 (after DB persist). The window between
        // can show a "stale" row here — but the `stopped:` filter above
        // already removed those, so anything reaching this branch is a
        // genuine pre-first-ping session.
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
