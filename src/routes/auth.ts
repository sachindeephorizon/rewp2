import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { signToken, authMiddleware } from "../middleware/auth";
import type { AuthenticatedRequest } from "../types";

const router = Router();

// ── POST /auth/register ─────────────────────────────────────────────
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body as {
      name?: string;
      email?: string;
      password?: string;
    };

    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email, and password are required" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }

    // Check if email already exists
    const existing = await pool.query("SELECT id FROM app_users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO app_users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at",
      [name.trim(), email.toLowerCase().trim(), hash]
    );

    const user = result.rows[0] as { id: number; name: string; email: string };
    const token = signToken(user);

    res.status(201).json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("[POST /auth/register] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /auth/login ────────────────────────────────────────────────
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    const result = await pool.query(
      "SELECT id, name, email, password_hash FROM app_users WHERE email = $1",
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const user = result.rows[0] as { id: number; name: string; email: string; password_hash: string };
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = signToken(user);

    res.status(200).json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("[POST /auth/login] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /auth/me ────────────────────────────────────────────────────
router.get("/me", authMiddleware, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await pool.query(
      "SELECT id, name, email, created_at FROM app_users WHERE id = $1",
      [authReq.user.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(200).json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error("[GET /auth/me] Error:", (err as Error).message);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
