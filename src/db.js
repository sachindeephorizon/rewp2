const { Pool } = require("pg");

/**
 * FIX: Configured pool properly for long sessions (10hr+).
 *
 * Without these settings, 1s pings exhaust Postgres connections within hours:
 *
 * max: 10          — Render free Postgres allows 25 total connections.
 *                    With cluster workers each needing a pool, cap at 10
 *                    per worker to stay safely under the limit.
 *
 * idleTimeoutMillis: 30000  — Close idle connections after 30s.
 *                             Without this, connections stay open forever
 *                             and you hit the 25-connection cap within hours.
 *
 * connectionTimeoutMillis: 5000 — If a connection can't be acquired in 5s,
 *                                  fail fast with an error instead of hanging
 *                                  the request indefinitely.
 *
 * allowExitOnIdle: true  — Allow the process to exit cleanly when all
 *                          connections are idle (important for graceful shutdown).
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,                      // FIX: was unlimited — exhausts Render's 25-connection cap
  idleTimeoutMillis: 30000,     // FIX: was never set — connections leaked forever
  connectionTimeoutMillis: 5000, // FIX: was never set — hung requests on DB overload
  allowExitOnIdle: true,
});

pool.on("error", (err) => console.error("[Postgres] Pool error:", err.message));

// ── Pool health monitoring for long sessions ──────────────────────
// Logs pool stats every 5 minutes so you can see connection usage on Render logs.
// Helps diagnose connection leaks during long tracking sessions.
setInterval(() => {
  console.log(
    `[Postgres] Pool stats | total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
  );
}, 5 * 60 * 1000);

/**
 * Connect to PostgreSQL and create tables if they don't exist.
 *
 * Schema:
 *   sessions       — one row per tracking session (userId + start/end time)
 *   location_logs  — every location ping recorded during a session
 */
async function connectDB() {
  try {
    const client = await pool.connect();
    console.log("[Postgres] Connected");

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(100) NOT NULL,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id            SERIAL PRIMARY KEY,
        user_id       VARCHAR(100) NOT NULL,
        session_name  VARCHAR(100) NOT NULL,
        started_at    TIMESTAMPTZ NOT NULL,
        ended_at      TIMESTAMPTZ NOT NULL,
        duration_secs INTEGER NOT NULL,
        total_pings   INTEGER NOT NULL DEFAULT 0,
        start_location VARCHAR(255),
        end_location   VARCHAR(255),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS start_location VARCHAR(255);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS end_location VARCHAR(255);

      CREATE TABLE IF NOT EXISTS location_logs (
        id          SERIAL PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lat         DOUBLE PRECISION NOT NULL,
        lng         DOUBLE PRECISION NOT NULL,
        h3_cell     VARCHAR(20),
        recorded_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS h3_cell VARCHAR(20);

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_location_logs_session_id ON location_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_location_logs_h3_cell ON location_logs(h3_cell);

      -- FIX: Add index on recorded_at for fast time-range queries on large sessions.
      -- A 10hr session at 1s pings = 36,000 rows. Without this index,
      -- querying logs by time does a full table scan and gets slower every session.
      CREATE INDEX IF NOT EXISTS idx_location_logs_recorded_at ON location_logs(recorded_at);

      -- FIX: Composite index for the most common query pattern:
      -- "give me all logs for session X ordered by time"
      CREATE INDEX IF NOT EXISTS idx_location_logs_session_time
        ON location_logs(session_id, recorded_at ASC);
    `);

    client.release();
    console.log("[Postgres] Tables ready");
  } catch (err) {
    console.error("[Postgres] Failed to connect:", err.message);
    process.exit(1);
  }
}

module.exports = { pool, connectDB };