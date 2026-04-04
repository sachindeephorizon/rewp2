/**
 * ═══════════════════════════════════════════════════════════════════
 *  Redis Stream Consumer Worker
 *
 *  Reads location pings from the stream, batches them per session,
 *  bulk-inserts into PostgreSQL, then acknowledges.
 *
 *  Features:
 *    - XREADGROUP with BLOCK for efficient waiting
 *    - Batch insert (single INSERT with multiple VALUES)
 *    - Idempotency via stream_id unique index
 *    - XPENDING + XAUTOCLAIM for stuck message recovery
 *    - Graceful shutdown
 * ═══════════════════════════════════════════════════════════════════
 */
const { redis } = require("./redis");
const { pool } = require("./db");
const {
  STREAM_NAME,
  CONSUMER_GROUP,
  CONSUMER_NAME,
  STREAM_BATCH_SIZE,
  STREAM_BLOCK_MS,
  PENDING_CHECK_INTERVAL,
  PENDING_IDLE_MS,
} = require("./config");

let running = false;
let shutdownRequested = false;

// ── Parse stream entry into a location object ──────────────────────
function parseEntry(id, fields) {
  // fields is an object: { userId, sessionId, lat, lng, accuracy, ts }
  return {
    streamId: id,
    userId: fields.userId,
    sessionId: parseInt(fields.sessionId, 10),
    lat: parseFloat(fields.lat),
    lng: parseFloat(fields.lng),
    accuracy: fields.accuracy ? parseFloat(fields.accuracy) : null,
    timestamp: fields.ts || new Date().toISOString(),
  };
}

// ── Batch insert into PostgreSQL ───────────────────────────────────
async function batchInsert(entries) {
  if (entries.length === 0) return;

  // Group by sessionId for efficient inserts
  const bySession = new Map();
  for (const e of entries) {
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId).push(e);
  }

  for (const [sessionId, points] of bySession) {
    const BATCH = 500;
    for (let b = 0; b < points.length; b += BATCH) {
      const batch = points.slice(b, b + BATCH);
      const values = [];
      const params = [];

      batch.forEach((p, i) => {
        const o = i * 5;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`);
        params.push(sessionId, p.lat, p.lng, p.timestamp, p.streamId);
      });

      // ON CONFLICT — idempotency: if stream_id already inserted, skip
      await pool.query(
        `INSERT INTO location_logs (session_id, lat, lng, recorded_at, stream_id)
         VALUES ${values.join(", ")}
         ON CONFLICT (stream_id) WHERE stream_id IS NOT NULL DO NOTHING`,
        params
      );
    }
  }
}

// ── Acknowledge processed messages ─────────────────────────────────
async function ackMessages(ids) {
  if (ids.length === 0) return;
  await redis.xAck(STREAM_NAME, CONSUMER_GROUP, ids);
}

// ── Main consumer loop ─────────────────────────────────────────────
async function consumeLoop() {
  console.log(`[Worker] Consumer "${CONSUMER_NAME}" started on "${STREAM_NAME}"`);

  while (!shutdownRequested) {
    try {
      // Read new messages — ">" means only undelivered messages
      const response = await redis.xReadGroup(
        CONSUMER_GROUP,
        CONSUMER_NAME,
        [{ key: STREAM_NAME, id: ">" }],
        { COUNT: STREAM_BATCH_SIZE, BLOCK: STREAM_BLOCK_MS }
      );

      if (!response || response.length === 0) continue;

      const stream = response[0]; // we only read one stream
      const messages = stream.messages;
      if (!messages || messages.length === 0) continue;

      // Parse all entries
      const entries = [];
      const ids = [];

      for (const msg of messages) {
        try {
          const entry = parseEntry(msg.id, msg.message);
          if (!isNaN(entry.sessionId) && !isNaN(entry.lat) && !isNaN(entry.lng)) {
            entries.push(entry);
          }
          ids.push(msg.id);
        } catch (parseErr) {
          console.error("[Worker] Failed to parse entry:", msg.id, parseErr.message);
          ids.push(msg.id); // ACK bad messages so they don't block
        }
      }

      // Batch insert into PostgreSQL
      if (entries.length > 0) {
        await batchInsert(entries);
      }

      // Acknowledge all processed messages
      await ackMessages(ids);

      console.log(`[Worker] Processed ${entries.length} entries, ACK'd ${ids.length} messages`);
    } catch (err) {
      if (shutdownRequested) break;
      console.error("[Worker] Consumer error:", err.message);
      // Back off on error to avoid tight loop
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log("[Worker] Consumer loop stopped");
}

// ── Reclaim stuck messages (pending > PENDING_IDLE_MS) ─────────────
async function reclaimPending() {
  while (!shutdownRequested) {
    try {
      // XAUTOCLAIM: grab messages that have been pending > PENDING_IDLE_MS
      const result = await redis.xAutoClaim(
        STREAM_NAME,
        CONSUMER_GROUP,
        CONSUMER_NAME,
        PENDING_IDLE_MS,
        "0-0",
        { COUNT: 50 }
      );

      if (result && result.messages && result.messages.length > 0) {
        const entries = [];
        const ids = [];

        for (const msg of result.messages) {
          try {
            const entry = parseEntry(msg.id, msg.message);
            if (!isNaN(entry.sessionId) && !isNaN(entry.lat) && !isNaN(entry.lng)) {
              entries.push(entry);
            }
            ids.push(msg.id);
          } catch {
            ids.push(msg.id);
          }
        }

        if (entries.length > 0) {
          await batchInsert(entries);
        }
        await ackMessages(ids);
        console.log(`[Worker] Reclaimed ${ids.length} pending messages`);
      }
    } catch (err) {
      // XAUTOCLAIM not available on older Redis — fall back silently
      if (err.message && err.message.includes("unknown command")) {
        console.log("[Worker] XAUTOCLAIM not supported — skipping pending recovery");
        return; // stop the loop, don't retry
      }
      if (!shutdownRequested) {
        console.error("[Worker] Reclaim error:", err.message);
      }
    }

    // Wait before next check
    await new Promise((r) => setTimeout(r, PENDING_CHECK_INTERVAL));
  }
}

// ── Start the worker ───────────────────────────────────────────────
async function startWorker() {
  if (running) return;
  running = true;
  shutdownRequested = false;

  // Run consumer loop and pending reclaimer in parallel
  Promise.all([consumeLoop(), reclaimPending()]).catch((err) => {
    console.error("[Worker] Fatal error:", err.message);
  });
}

// ── Graceful shutdown ──────────────────────────────────────────────
async function stopWorker() {
  console.log("[Worker] Shutting down...");
  shutdownRequested = true;
  running = false;
}

module.exports = { startWorker, stopWorker };
