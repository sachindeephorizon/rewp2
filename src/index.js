/**
 * ═══════════════════════════════════════════════════════════════════
 *  Real-Time Location Tracking Backend
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Architecture (with Redis Streams):
 *
 *  Mobile App
 *    │  POST /:id/ping { lat, lng }
 *    ▼
 *  ┌──────────────────────────────────────────────────┐
 *  │  Express Server                                  │
 *  │    ├─ Redis SET  user:{userId}  (live location)  │
 *  │    ├─ Redis PUBLISH (Socket.io → dashboard)      │
 *  │    └─ Redis XADD location_stream (durable log)   │
 *  └──────────────────────────────────────────────────┘
 *       │                              │
 *       ▼ (real-time)                  ▼ (durable)
 *    Dashboard                   Stream Worker
 *    (Socket.io)                   │  XREADGROUP
 *                                  │  Batch 100 msgs
 *                                  ▼  INSERT INTO PostgreSQL
 *                                  │  XACK
 */

require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");

const { connectRedis } = require("./redis");
const { connectDB } = require("./db");
const { initSocket } = require("./socket");
const { initStream } = require("./stream");
const { startWorker, stopWorker } = require("./worker");
const routes = require("./routes");

const app = express();
const PORT = process.env.PORT || 9001;

// ── Middleware ───────────────────────────────────────────────────────

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ── Health check ────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    pid: process.pid,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
  });
});

// ── Routes ──────────────────────────────────────────────────────────

app.use("/", routes);

// ── Server bootstrap ────────────────────────────────────────────────

async function start() {
  await connectRedis();
  await connectDB();
  await initStream();   // Create stream + consumer group
  startWorker();        // Start stream consumer (in-process)

  const server = http.createServer(app);
  initSocket(server);

  server.listen(PORT, () => {
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Worker ${process.pid} | Port ${PORT}`);
    console.log("  Stream: location_stream → location_workers");
    console.log("  Scaling: Redis adapter ✓ | Rate limiter ✓");
    console.log("═══════════════════════════════════════════════════");

    // Self-ping to prevent Render/Railway from sleeping
    setInterval(() => {
      fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 13 * 60 * 1000);
  });

  // ── Graceful shutdown ───────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n[Server] ${signal} received, shutting down...`);
    await stopWorker();   // Stop consuming, finish current batch
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});
