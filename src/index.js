/**
 * ═══════════════════════════════════════════════════════════════════
 *  Real-Time Location Tracking Backend
 * ═══════════════════════════════════════════════════════════════════
 *
 * Architecture:
 *
 *   Frontend (mobile/web)
 *       │
 *       │  POST /:id/ping  { lat, lng }  (every ~10s)
 *       ▼
 *   ┌──────────────────────────────────────────────────┐
 *   │  Express Server (Instance A, B, C …)             │
 *   │    ├─ Redis SET  user:{userId}  (TTL 60s)        │
 *   │    └─ Redis PUBLISH "location_updates"           │
 *   └──────────────────────────────────────────────────┘
 *       │
 *       ▼  (Redis Pub/Sub fans out to ALL instances)
 *   ┌──────────────────────────────────────────────────┐
 *   │  Redis Subscriber (per instance)                 │
 *   │    └─ Socket.io  io.emit("locationUpdate", data) │
 *   └──────────────────────────────────────────────────┘
 *       │
 *       ▼
 *   Agent Dashboard (WebSocket clients)
 *
 * Horizontal scaling:
 *   Run N instances behind a load balancer. Each has its own
 *   Socket.io server + Redis subscriber. Because Redis Pub/Sub
 *   delivers to every subscriber, ALL dashboard clients see
 *   every update — no matter which instance received the POST.
 */

require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");

const { connectRedis } = require("./redis");
const { connectDB } = require("./db");
const { initSocket } = require("./socket");
const locationRoutes = require("./routes/location");

const app = express();
const PORT = process.env.PORT || 9001;

// ── Middleware ───────────────────────────────────────────────────────

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ── Health check ────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── Dashboard ────────────────────────────────────────────────────────

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "dashboard.html"));
});

// ── Routes ──────────────────────────────────────────────────────────

app.use("/", locationRoutes);

// ── Server bootstrap ────────────────────────────────────────────────
// We create a raw http.Server so both Express and Socket.io share
// the same port (required by Socket.io).

async function start() {
  await connectRedis();
  await connectDB();
  const server = http.createServer(app);
  initSocket(server);

  // 3. Start listening
  server.listen(PORT, () => {
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Location Tracking Backend running on port ${PORT}`);
    console.log("  Endpoints:");
    console.log("    POST /:id/ping       → update user location");
    console.log("    GET  /user/:id       → fetch latest location");
    console.log("    GET  /users/active   → list active users");
    console.log("    GET  /health         → health check");
    console.log("    WS   /              → Socket.io (locationUpdate)");
    console.log("═══════════════════════════════════════════════════");
  });

  // ── Graceful shutdown ───────────────────────────────────────────
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
