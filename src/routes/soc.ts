/**
 * SOC REST surface.
 *
 * Primary delivery of SOC events is Socket.IO + (optional) webhook. These
 * endpoints exist so the dashboard can:
 *   - render a history page without subscribing to the socket
 *   - ack an event over HTTP when a socket ack round-trip isn't available
 *   - probe the pending queue for monitoring/alerting
 */

import express, { Router, Request, Response } from "express";
import {
  listRecentSocEvents,
  listPendingSocEvents,
  markSocEventAcked,
} from "../services/soc.dispatch.service";

const router: Router = express.Router();

// GET /soc/events?limit=50&offset=0
router.get("/events", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  try {
    const events = await listRecentSocEvents(limit, offset);
    res.json({ events, limit, offset });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /soc/events/pending?limit=100
router.get("/events/pending", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
  try {
    const events = await listPendingSocEvents(limit);
    res.json({ events, count: events.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /soc/events/:id/ack — body: { agentId? }
router.post(
  "/events/:id/ack",
  async (req: Request<{ id: string }>, res: Response) => {
    const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : null;
    try {
      await markSocEventAcked(req.params.id, agentId, "webhook");
      res.json({ id: req.params.id, acked: true, acked_by: agentId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

export default router;
