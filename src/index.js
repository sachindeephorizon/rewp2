require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");

const { connectRedis, redis } = require("./redis");
const { connectDB } = require("./db");
const { initSocket } = require("./socket");
const { initGpsState } = require("./utils/gps");
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

  // FIX: Wire Redis client into gps.js so userStates survive server restarts
  initGpsState(redis);

  const server = http.createServer(app);
  initSocket(server);

  server.listen(PORT, () => {
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Worker ${process.pid} | Port ${PORT}`);
    console.log("  Scaling: Redis adapter ✓ | Rate limiter ✓");
    console.log("═══════════════════════════════════════════════════");

    // FIX: Self-ping must use the public Railway URL, not localhost.
    // localhost only pings the process internally and does NOT prevent
    // Railway from sleeping the instance after inactivity.
    const PUBLIC_URL = process.env.PUBLIC_URL ||
      "https://livetracker-production-e412.up.railway.app";

    setInterval(() => {
      fetch(`${PUBLIC_URL}/health`)
        .then(() => console.log("[keepalive] ping ok"))
        .catch((err) => console.warn("[keepalive] ping failed:", err.message));
    }, 13 * 60 * 1000); // every 13 minutes
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

start().catch((err) => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});