import { Router } from "express";

import authRoutes from "./auth";
import trackingRoutes from "./tracking";
import usersRoutes from "./users";
import sessionsRoutes from "./sessions";
import destinationRoutes from "./destination";
import entryRoutes from "./entry";
import checkinRoutes from "./checkin";
import escalationRoutes from "./escalation";
import socRoutes from "./soc";

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

// POST /destination/:id/set, POST /destination/:id/clear, GET /destination/:id, GET /destination/:id/remaining
router.use("/destination", destinationRoutes);

// Session lifecycle (entry / checkin / escalation) — all live under /handling
// POST /handling/entry, PUT /handling/entry/:id/details, PUT /handling/entry/:id/end, GET /handling/entry/:id/dashboard, GET /handling/entry/:id/summary, ...
// POST /handling/checkin/:id/start, POST /handling/checkin/:id/respond, ...
// POST /handling/escalation/:id/trigger, PUT /handling/escalation/:id/safe, ...
router.use("/handling", entryRoutes);
router.use("/handling", checkinRoutes);
router.use("/handling", escalationRoutes);

// SOC dashboard surface — history / pending / ack
// GET /soc/events, GET /soc/events/pending, POST /soc/events/:id/ack
router.use("/soc", socRoutes);

export default router;
