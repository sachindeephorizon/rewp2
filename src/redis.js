

const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL ;

const redis = createClient({ url: REDIS_URL });

const subscriber = redis.duplicate();

// ── Connection helpers ──────────────────────────────────────────────

async function connectRedis() {
  try {
    await redis.connect();
    console.log("[Redis] Main client connected");

    await subscriber.connect();
    console.log("[Redis] Subscriber client connected");
  } catch (err) {
    console.error("[Redis] Failed to connect:", err.message);
    process.exit(1); // fail fast — Redis is essential
  }
}

redis.on("error", (err) => console.error("[Redis:main] error:", err.message));
subscriber.on("error", (err) => console.error("[Redis:sub] error:", err.message));

module.exports = { redis, subscriber, connectRedis };
