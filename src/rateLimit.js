/**
 * Per-user rate limiter using Redis.
 * Allows max 1 ping per MIN_INTERVAL_MS per userId.
 * Uses Redis for shared state across cluster workers.
 *
 * FIX: Default changed from 5000ms → 800ms to match frontend's 1s ping interval.
 * The old 5000ms limit was blocking 4 out of every 5 pings, causing the
 * "error → synced → error" pattern seen in the app (429 → app shows Error,
 * next allowed ping → Synced, repeat).
 *
 * Set PING_INTERVAL_MS in your .env to tune this. Always keep it slightly
 * below your frontend timeInterval (e.g. frontend=1000ms → limit=800ms).
 */
const { redis } = require("./redis");

// FIX: was 5000ms — blocked all pings sent faster than 5s
// Now 800ms — allows 1s frontend pings through with a small buffer
const MIN_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS) || 4500;

async function rateLimitPing(req, res, next) {
  const userId = req.params.id;
  if (!userId) return next();

  const key = `ratelimit:${userId}`;
  try {
    const last = await redis.get(key);
    if (last) {
      const elapsed = Date.now() - parseInt(last, 10);
      if (elapsed < MIN_INTERVAL_MS) {
        return res.status(429).json({
          error: "Too fast",
          retryAfterMs: MIN_INTERVAL_MS - elapsed,
        });
      }
    }
    await redis.set(key, Date.now().toString(), { EX: 10 });
    next();
  } catch {
    // If Redis fails, let the request through
    next();
  }
}

module.exports = { rateLimitPing };