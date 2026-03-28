const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => console.error("[Postgres] Pool error:", err.message));

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
      CREATE TABLE IF NOT EXISTS sessions (
        id            SERIAL PRIMARY KEY,
        user_id       VARCHAR(100) NOT NULL,
        session_name  VARCHAR(100) NOT NULL,
        started_at    TIMESTAMPTZ NOT NULL,
        ended_at      TIMESTAMPTZ NOT NULL,
        duration_secs INTEGER NOT NULL,
        total_pings   INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS location_logs (
        id          SERIAL PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lat         DOUBLE PRECISION NOT NULL,
        lng         DOUBLE PRECISION NOT NULL,
        speed       DOUBLE PRECISION,
        recorded_at TIMESTAMPTZ NOT NULL
      );

      -- Add speed column if table already exists without it
      ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS speed DOUBLE PRECISION;

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_location_logs_session_id ON location_logs(session_id);
    `);

    client.release();
    console.log("[Postgres] Tables ready");
  } catch (err) {
    console.error("[Postgres] Failed to connect:", err.message);
    process.exit(1);
  }
}

module.exports = { pool, connectDB };
