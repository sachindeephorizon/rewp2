import { Router, type Request, type Response } from "express";
import { pool } from "../db";

const router = Router();

const SESSION_FIELDS = `id, user_id, session_name, status, trip_type, started_at, ended_at, duration_secs, total_pings,
  start_location, end_location, origin_lat, origin_lng, dest_lat, dest_lng, dest_label,
  route_polyline, route_h3_corridor, total_distance_m, deviation_count, created_at`;

// ── GET /sessions/all ────────────────────────────────────────────────

router.get("/all", async (req: Request, res: Response) => {
  try {
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions"),
      pool.query(
        `SELECT ${SESSION_FIELDS} FROM sessions ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total as string, 10);

    res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /sessions/all] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /session/:sessionId/logs ────────────────────────────────────

router.get("/:sessionId/logs", async (req: Request, res: Response) => {
  try {
    const sid = parseInt(req.params.sessionId as string, 10);
    if (isNaN(sid)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 500, 2000);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM location_logs WHERE session_id = $1", [sid]),
      pool.query(
        `SELECT lat, lng, h3_cell, speed_kmh, accuracy_m, deviation_flag, inactivity_flag, recorded_at
         FROM location_logs
         WHERE session_id = $1 ORDER BY recorded_at ASC LIMIT $2 OFFSET $3`,
        [sid, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total as string, 10);

    res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /session/:id/logs] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /session/:sessionId ──────────────────────────────────────

router.delete("/:sessionId", async (req: Request, res: Response) => {
  try {
    const sid = parseInt(req.params.sessionId as string, 10);
    if (isNaN(sid)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }

    const result = await pool.query(
      "DELETE FROM sessions WHERE id = $1 RETURNING id",
      [sid]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.status(200).json({ ok: true, deleted: sid });
  } catch (err) {
    console.error("[DELETE /session/:id] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/sessions ──────────────────────────────────────────

router.get("/user/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions WHERE user_id = $1", [id]),
      pool.query(
        `SELECT ${SESSION_FIELDS} FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total as string, 10);

    res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /user/:id/sessions] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /session/:sessionId/deviations ──────────────────────────────

router.get("/:sessionId/deviations", async (req: Request, res: Response) => {
  try {
    const sid = parseInt(req.params.sessionId as string, 10);
    if (isNaN(sid)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }

    const result = await pool.query(
      `SELECT id, user_id, lat, lng, h3_cell, distance_from_route, zone, consecutive,
              detected_at, destination_name, resolved_at
       FROM deviations WHERE session_id = $1 ORDER BY detected_at ASC`,
      [sid]
    );

    res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("[GET /session/:id/deviations] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /session/:sessionId/events ──────────────────────────────────

router.get("/:sessionId/events", async (req: Request, res: Response) => {
  try {
    const sid = parseInt(req.params.sessionId as string, 10);
    if (isNaN(sid)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }

    const result = await pool.query(
      `SELECT id, session_id, user_id, event_type, occurred_at, lat, lng, h3_cell, metadata
       FROM session_events WHERE session_id = $1 ORDER BY occurred_at ASC`,
      [sid]
    );

    res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("[GET /session/:id/events] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/events ────────────────────────────────────────────

router.get("/user/:id/events", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

    const result = await pool.query(
      `SELECT id, session_id, user_id, event_type, occurred_at, lat, lng, h3_cell, metadata
       FROM session_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
      [id, limit]
    );

    res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("[GET /user/:id/events] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/deviations ────────────────────────────────────────

router.get("/user/:id/deviations", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const result = await pool.query(
      `SELECT id, session_id, lat, lng, h3_cell, distance_from_route, zone, consecutive,
              detected_at, destination_name, resolved_at
       FROM deviations WHERE user_id = $1 ORDER BY detected_at DESC LIMIT $2`,
      [id, limit]
    );

    res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("[GET /user/:id/deviations] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
