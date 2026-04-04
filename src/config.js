module.exports = {
  LOCATION_TTL: 300,          // 5 min — buffer for background/offline gaps
  SESSION_TTL: 86400,         // 24 hours — auto-expire stale session data
  TRAIL_MIN_DISTANCE: 5,      // meters — min distance between trail dots
  CHANNEL: "location_updates",
  ACTIVE_SET: "active_users",

  // Redis Streams
  STREAM_NAME: "location_stream",
  CONSUMER_GROUP: "location_workers",
  CONSUMER_NAME: `worker-${process.pid}`,
  STREAM_BATCH_SIZE: 100,     // messages per XREADGROUP
  STREAM_BLOCK_MS: 5000,      // block timeout for XREADGROUP
  WORKER_FLUSH_INTERVAL: 3000, // batch insert interval (ms)
  PENDING_CHECK_INTERVAL: 30000, // check for stuck messages every 30s
  PENDING_IDLE_MS: 60000,     // reclaim messages idle > 60s
};
