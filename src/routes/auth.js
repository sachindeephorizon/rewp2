const { Router } = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { signToken, authMiddleware } = require("../middleware/auth");

const router = Router();

// ── POST /auth/register ─────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Check if email already exists
    const existing = await pool.query("SELECT id FROM app_users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO app_users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at",
      [name.trim(), email.toLowerCase().trim(), hash]
    );

    const user = result.rows[0];
    const token = signToken(user);

    return res.status(201).json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("[POST /auth/register] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/login ────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const result = await pool.query(
      "SELECT id, name, email, password_hash FROM app_users WHERE email = $1",
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);

    return res.status(200).json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("[POST /auth/login] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /auth/me ────────────────────────────────────────────────────
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, created_at FROM app_users WHERE id = $1",
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.status(200).json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error("[GET /auth/me] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
