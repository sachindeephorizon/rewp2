/**
 * Per-user rate limiter using Redis.
 * Allows max 1 ping per MIN_INTERVAL_MS per userId.
 * Uses Redis for shared state across cluster workers.
 *
 * FIX: Default changed from 5000ms → 800ms to match frontend's 1s ping interval.
 */
import type { Request, Response, NextFunction } from "express";
import { redis } from "../redis";

// FIX: was 5000ms — blocked all pings sent faster than 5s
// Now 800ms — allows 1s frontend pings through with a small buffer
const MIN_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || "", 10) || 800;

export async function rateLimitPing(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.params.id;
  if (!userId) {
    next();
    return;
  }

  const key = `ratelimit:${userId}`;
  try {
    const last = await redis.get(key);
    if (last) {
      const elapsed = Date.now() - parseInt(last, 10);
      if (elapsed < MIN_INTERVAL_MS) {
        res.status(429).json({
          error: "Too fast",
          retryAfterMs: MIN_INTERVAL_MS - elapsed,
        });
        return;
      }
    }
    await redis.set(key, Date.now().toString(), { EX: 10 });
    next();
  } catch {
    // If Redis fails, let the request through
    next();
  }
}
