import "dotenv/config";

import http from "http";
import express from "express";
import cors from "cors";

import { connectRedis, redis } from "./redis";
import { connectDB } from "./db";
import { initSocket } from "./socket";
import { initGpsState } from "./utils/gps";
import routes from "./routes";
import { startSocRetryWorker } from "./services/soc.dispatch.service";
import { startPingGapWatcher } from "./services/ping-gap.watcher";

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

async function start(): Promise<void> {
  await connectRedis();
  await connectDB();

  // FIX: Wire Redis client into gps.js so userStates survive server restarts
  initGpsState(redis);

  const server = http.createServer(app);
  initSocket(server);
  startSocRetryWorker();
  startPingGapWatcher();

  server.listen(PORT, () => {
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Worker ${process.pid} | Port ${PORT}`);
    console.log("  Scaling: Redis adapter ✓ | Rate limiter ✓");
    console.log("═══════════════════════════════════════════════════");

    const PUBLIC_URL = process.env.PUBLIC_URL ||
      "https://livetracker-production-e412.up.railway.app";

    setInterval(() => {
      fetch(`${PUBLIC_URL}/health`)
        .then(() => console.log("[keepalive] ping ok"))
        .catch((err: Error) => console.warn("[keepalive] ping failed:", err.message));
    }, 13 * 60 * 1000);
  });

  process.on("SIGINT", () => {
    console.log("\n[Server] Shutting down gracefully...");
    server.close(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    console.log("\n[Server] SIGTERM received, shutting down...");
    server.close(() => process.exit(0));
  });
}

start().catch((err: unknown) => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});
