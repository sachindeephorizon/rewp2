const { Router } = require("express");
const { pool } = require("../db");

const router = Router();

const SESSION_FIELDS = `id, user_id, session_name, started_at, ended_at, duration_secs, total_pings, start_location, end_location, created_at`;

// ── GET /sessions/all ────────────────────────────────────────────────

router.get("/all", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions"),
      pool.query(
        `SELECT ${SESSION_FIELDS} FROM sessions ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /sessions/all] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /session/:sessionId/logs ────────────────────────────────────

router.get("/:sessionId/logs", async (req, res) => {
  try {
    const sid = parseInt(req.params.sessionId, 10);
    if (isNaN(sid)) {
      return res.status(400).json({ error: "Invalid session id" });
    }
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM location_logs WHERE session_id = $1", [sid]),
      pool.query(
        `SELECT lat, lng, recorded_at FROM location_logs
         WHERE session_id = $1 ORDER BY recorded_at ASC LIMIT $2 OFFSET $3`,
        [sid, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /session/:id/logs] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /session/:sessionId ──────────────────────────────────────

router.delete("/:sessionId", async (req, res) => {
  try {
    const sid = parseInt(req.params.sessionId, 10);
    if (isNaN(sid)) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const result = await pool.query(
      "DELETE FROM sessions WHERE id = $1 RETURNING id",
      [sid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    return res.status(200).json({ ok: true, deleted: sid });
  } catch (err) {
    console.error("[DELETE /session/:id] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/sessions ──────────────────────────────────────────

router.get("/user/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const [countResult, result] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM sessions WHERE user_id = $1", [id]),
      pool.query(
        `SELECT ${SESSION_FIELDS} FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.status(200).json({
      ok: true,
      data: result.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[GET /user/:id/sessions] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /session/:sessionId/deviations ──────────────────────────────

router.get("/:sessionId/deviations", async (req, res) => {
  try {
    const sid = parseInt(req.params.sessionId, 10);
    if (isNaN(sid)) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const result = await pool.query(
      `SELECT id, user_id, lat, lng, h3_cell, distance_from_route, zone, consecutive,
              detected_at, destination_name, resolved_at
       FROM deviations WHERE session_id = $1 ORDER BY detected_at ASC`,
      [sid]
    );

    return res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("[GET /session/:id/deviations] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /user/:id/deviations — all deviations for a user ───────────

router.get("/user/:id/deviations", async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const result = await pool.query(
      `SELECT id, session_id, lat, lng, h3_cell, distance_from_route, zone, consecutive,
              detected_at, destination_name, resolved_at
       FROM deviations WHERE user_id = $1 ORDER BY detected_at DESC LIMIT $2`,
      [id, limit]
    );

    return res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("[GET /user/:id/deviations] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
