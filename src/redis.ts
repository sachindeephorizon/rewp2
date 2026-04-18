import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL;

const redis = createClient({ url: REDIS_URL });
const subscriber = redis.duplicate();

// Dedicated pub/sub pair for Socket.io Redis adapter
const ioPub = redis.duplicate();
const ioSub = redis.duplicate();

// ── Connection helpers ──────────────────────────────────────────────

async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
    console.log("[Redis] Main client connected");

    await subscriber.connect();
    console.log("[Redis] Subscriber client connected");

    await ioPub.connect();
    await ioSub.connect();
    console.log("[Redis] Socket.io adapter clients connected");
  } catch (err) {
    console.error("[Redis] Failed to connect:", (err as Error).message);
    process.exit(1);
  }
}

redis.on("error", (err: Error) => console.error("[Redis:main] error:", err.message));
subscriber.on("error", (err: Error) => console.error("[Redis:sub] error:", err.message));

export { redis, subscriber, ioPub, ioSub, connectRedis };
