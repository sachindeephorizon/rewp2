import { Pool } from "pg";

/**
 * FIX: Configured pool properly for long sessions (10hr+).
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true,
});

pool.on("error", (err: Error) => console.error("[Postgres] Pool error:", err.message));

// ── Pool health monitoring for long sessions ──────────────────────
setInterval(() => {
  console.log(
    `[Postgres] Pool stats | total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
  );
}, 5 * 60 * 1000);

/**
 * Connect to PostgreSQL and create tables if they don't exist.
 */
async function connectDB(): Promise<void> {
  try {
    const client = await pool.connect();
    console.log("[Postgres] Connected");

    await client.query(`
      -- ═══════════════════════════════════════════════════════════════
      -- USERS
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS app_users (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(100) NOT NULL,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- ═══════════════════════════════════════════════════════════════
      -- SESSIONS
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS sessions (
        id              SERIAL PRIMARY KEY,
        user_id         VARCHAR(100) NOT NULL,
        session_name    VARCHAR(100) NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active',
        trip_type       TEXT,
        started_at      TIMESTAMPTZ NOT NULL,
        ended_at        TIMESTAMPTZ NOT NULL,
        duration_secs   INTEGER NOT NULL,
        total_pings     INTEGER NOT NULL DEFAULT 0,
        start_location  VARCHAR(255),
        end_location    VARCHAR(255),
        origin_lat      DOUBLE PRECISION,
        origin_lng      DOUBLE PRECISION,
        dest_lat        DOUBLE PRECISION,
        dest_lng        DOUBLE PRECISION,
        dest_label      TEXT,
        route_polyline   TEXT,
        route_h3_corridor TEXT,
        total_distance_m DOUBLE PRECISION DEFAULT 0,
        deviation_count  INTEGER DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS start_location VARCHAR(255);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS end_location VARCHAR(255);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS trip_type TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS origin_lat DOUBLE PRECISION;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS origin_lng DOUBLE PRECISION;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dest_lat DOUBLE PRECISION;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dest_lng DOUBLE PRECISION;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dest_label TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS route_polyline TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS route_h3_corridor TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_distance_m DOUBLE PRECISION DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deviation_count INTEGER DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

      -- ═══════════════════════════════════════════════════════════════
      -- LOCATION_LOGS
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS location_logs (
        id              SERIAL PRIMARY KEY,
        session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lat             DOUBLE PRECISION NOT NULL,
        lng             DOUBLE PRECISION NOT NULL,
        h3_cell         VARCHAR(20),
        speed_kmh       DOUBLE PRECISION,
        accuracy_m      DOUBLE PRECISION,
        deviation_flag  BOOLEAN DEFAULT FALSE,
        inactivity_flag BOOLEAN DEFAULT FALSE,
        recorded_at     TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS h3_cell VARCHAR(20);
      ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS speed_kmh DOUBLE PRECISION;
      ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS accuracy_m DOUBLE PRECISION;
      ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS deviation_flag BOOLEAN DEFAULT FALSE;
      ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS inactivity_flag BOOLEAN DEFAULT FALSE;

      CREATE INDEX IF NOT EXISTS idx_location_logs_session_id ON location_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_location_logs_h3_cell ON location_logs(h3_cell);
      CREATE INDEX IF NOT EXISTS idx_location_logs_recorded_at ON location_logs(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_location_logs_session_time
        ON location_logs(session_id, recorded_at ASC);

      -- ═══════════════════════════════════════════════════════════════
      -- DEVIATIONS
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS deviations (
        id                  SERIAL PRIMARY KEY,
        user_id             VARCHAR(100) NOT NULL,
        session_id          INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        lat                 DOUBLE PRECISION NOT NULL,
        lng                 DOUBLE PRECISION NOT NULL,
        h3_cell             VARCHAR(20),
        distance_from_route DOUBLE PRECISION,
        zone                VARCHAR(20) NOT NULL DEFAULT 'OUTSIDE',
        consecutive         INTEGER NOT NULL DEFAULT 1,
        detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        destination_name    VARCHAR(255),
        resolved_at         TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_deviations_user_id ON deviations(user_id);
      CREATE INDEX IF NOT EXISTS idx_deviations_session_id ON deviations(session_id);
      CREATE INDEX IF NOT EXISTS idx_deviations_detected_at ON deviations(detected_at);

      -- ═══════════════════════════════════════════════════════════════
      -- SESSION_EVENTS
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS session_events (
        id          BIGSERIAL PRIMARY KEY,
        session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        user_id     VARCHAR(100) NOT NULL,
        event_type  TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lat         DOUBLE PRECISION,
        lng         DOUBLE PRECISION,
        h3_cell     VARCHAR(20),
        metadata    JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON session_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_time ON session_events(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_events_user ON session_events(user_id);

      -- ═══════════════════════════════════════════════════════════════
      -- H3_RISK_SCORES
      -- ═══════════════════════════════════════════════════════════════
      CREATE TABLE IF NOT EXISTS h3_risk_scores (
        h3_cell             VARCHAR(20) PRIMARY KEY,
        resolution          INTEGER NOT NULL DEFAULT 9,
        city                TEXT,
        total_sessions      INTEGER DEFAULT 0,
        deviation_events    INTEGER DEFAULT 0,
        escalation_events   INTEGER DEFAULT 0,
        inactivity_events   INTEGER DEFAULT 0,
        risk_score          DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        last_updated        TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_risk_h3_cell ON h3_risk_scores(h3_cell);
      CREATE INDEX IF NOT EXISTS idx_risk_score ON h3_risk_scores(risk_score);

      -- ═══════════════════════════════════════════════════════════════
      -- SOC_EVENTS (outbox for the SOC dashboard)
      -- ═══════════════════════════════════════════════════════════════
      -- Durable record of every monitoring event that should reach SOC.
      -- Rows are created synchronously with the triggering action (escalation,
      -- tier shift, missed check-in), then delivered asynchronously via
      -- Socket.IO (live) + optional HTTP webhook. If SOC is offline the rows
      -- simply stay with delivered_at IS NULL; a retry worker scans them and
      -- a fresh Socket.IO connection gets the backlog on join.
      CREATE TABLE IF NOT EXISTS soc_events (
        id               UUID PRIMARY KEY,
        user_id          VARCHAR(100) NOT NULL,
        session_id       VARCHAR(100),
        event_type       TEXT NOT NULL,
        severity         TEXT NOT NULL DEFAULT 'info',
        payload          JSONB NOT NULL,
        idempotency_key  TEXT UNIQUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at     TIMESTAMPTZ,
        delivered_via    TEXT,
        acked_by         TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_attempt_at  TIMESTAMPTZ,
        last_error       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_soc_events_pending
        ON soc_events(delivered_at, created_at)
        WHERE delivered_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_soc_events_user ON soc_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_soc_events_created ON soc_events(created_at DESC);
    `);

    client.release();
    console.log("[Postgres] Tables ready");
  } catch (err) {
    console.error("[Postgres] Failed to connect:", (err as Error).message);
    process.exit(1);
  }
}

export { pool, connectDB };
