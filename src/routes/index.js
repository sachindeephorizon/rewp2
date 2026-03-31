const { Router } = require("express");

const trackingRoutes = require("./tracking");
const usersRoutes = require("./users");
const sessionsRoutes = require("./sessions");

const router = Router();

// POST /:id/ping, POST /:id/stop
router.use("/", trackingRoutes);

// GET /users/active, GET /user/:id, GET /user/:id/trail
router.use("/users", usersRoutes);
router.use("/user", usersRoutes);

// GET /sessions/all, GET /session/:id/logs, DELETE /session/:id, GET /sessions/user/:id
router.use("/sessions", sessionsRoutes);
router.use("/session", sessionsRoutes);

module.exports = router;
