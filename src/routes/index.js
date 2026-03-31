const { Router } = require("express");

const authRoutes = require("./auth");
const trackingRoutes = require("./tracking");
const usersRoutes = require("./users");
const sessionsRoutes = require("./sessions");

const router = Router();

// POST /auth/register, POST /auth/login, GET /auth/me
router.use("/auth", authRoutes);

// POST /:id/ping, POST /:id/stop
router.use("/", trackingRoutes);

// GET /users/active, GET /user/:id, GET /user/:id/trail
router.use("/users", usersRoutes);
router.use("/user", usersRoutes);

// GET /sessions/all, GET /session/:id/logs, DELETE /session/:id, GET /sessions/user/:id
router.use("/sessions", sessionsRoutes);
router.use("/session", sessionsRoutes);

module.exports = router;
