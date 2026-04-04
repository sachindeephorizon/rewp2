/**
 * Standalone stream worker — run separately from the API server.
 *
 * Usage:
 *   node run-worker.js
 *
 * This is optional. By default, the worker runs in-process with the
 * API server (see src/index.js). Use this for horizontal scaling:
 *   - Instance 1: node src/index.js       (API + worker)
 *   - Instance 2: node run-worker.js      (worker only)
 *
 * Each worker gets its own consumer name (based on PID), so multiple
 * workers share the load via the consumer group.
 */

require("dotenv").config();

const { connectRedis } = require("./src/redis");
const { connectDB } = require("./src/db");
const { initStream } = require("./src/stream");
const { startWorker, stopWorker } = require("./src/worker");

async function main() {
  await connectRedis();
  await connectDB();
  await initStream();

  console.log("[StandaloneWorker] Starting...");
  startWorker();

  const shutdown = async (signal) => {
    console.log(`\n[StandaloneWorker] ${signal} — shutting down...`);
    await stopWorker();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[StandaloneWorker] Fatal:", err);
  process.exit(1);
});
