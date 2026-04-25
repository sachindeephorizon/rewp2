/**
 * SOC dispatch service.
 *
 * Every monitoring event that SOC should see (escalation triggered, tier
 * shift to emergency, check-in missed, "I need help", etc.) is routed
 * through `dispatchToSoc`. The function:
 *
 *   1. Writes the event to `soc_events` (durable outbox) — synchronous.
 *   2. Best-effort fan-out to the `soc:dashboard` Socket.IO room.
 *   3. Best-effort POST to `SOC_WEBHOOK_URL` with an HMAC-SHA256 signature.
 *   4. Marks the row delivered on either success. If both fail, the row
 *      stays pending; a retry worker (`startSocRetryWorker`) scans the
 *      outbox every 30 s and re-dispatches.
 *
 * When a SOC dashboard Socket.IO client joins (`subscribe:soc`), the
 * connection handler calls `flushPendingSocEventsTo(socket, agentId)` which
 * replays every undelivered event. This is the "SOC was offline, now it's
 * back" recovery path — no separate catch-up endpoint needed.
 */

import crypto from "crypto";
import { randomUUID } from "crypto";
import type { Socket } from "socket.io";
import { pool } from "../db";
import {
  SOC_ROOM,
  SOC_EVENT,
  SOC_MAX_ATTEMPTS,
  SOC_RETRY_BATCH_SIZE,
  SOC_RETRY_INTERVAL_MS,
} from "../config";

export type SocSeverity = "info" | "warning" | "critical";

export type SocEventType =
  | "escalation_triggered"
  | "escalation_advanced"
  | "escalation_resolved"
  | "tier_escalated"
  | "checkin_missed"
  | "user_needs_help"
  | "long_deviation"
  | "inactivity_emergency";

export interface SocEventInput {
  userId: string;
  sessionId?: string | null;
  type: SocEventType;
  severity?: SocSeverity;
  payload: Record<string, unknown>;
  // Optional dedupe key — if the same action fires twice (e.g. retry from
  // the mobile client), both calls insert once and the second returns the
  // existing row instead of creating a duplicate.
  idempotencyKey?: string;
}

export interface StoredSocEvent {
  id: string;
  user_id: string;
  session_id: string | null;
  event_type: string;
  severity: string;
  payload: Record<string, unknown>;
  created_at: string;
  delivered_at: string | null;
  attempts: number;
}

// ─── Webhook config ──────────────────────────────────────────────────────

const WEBHOOK_URL = process.env.SOC_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.SOC_WEBHOOK_SECRET || "";
const WEBHOOK_TIMEOUT_MS = 5_000;

function signWebhookBody(body: string): string {
  if (!WEBHOOK_SECRET) return "";
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

async function deliverViaWebhook(event: StoredSocEvent): Promise<boolean> {
  if (!WEBHOOK_URL) return false;
  const body = JSON.stringify({
    id: event.id,
    user_id: event.user_id,
    session_id: event.session_id,
    event_type: event.event_type,
    severity: event.severity,
    payload: event.payload,
    created_at: event.created_at,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Soc-Event-Id": event.id,
        "X-Soc-Signature": signWebhookBody(body),
      },
      body,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Socket.IO delivery ──────────────────────────────────────────────────

// Lazy-load `getIo` from socket.ts to avoid a circular import at module init.
async function getSocketIo() {
  const mod = await import("../socket");
  return mod.getIo();
}

async function deliverViaSocket(event: StoredSocEvent): Promise<boolean> {
  const io = await getSocketIo();
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(SOC_ROOM);
  if (!room || room.size === 0) return false; // no SOC clients connected
  io.to(SOC_ROOM).emit(SOC_EVENT, serializeForWire(event));
  return true;
}

function serializeForWire(event: StoredSocEvent) {
  return {
    id: event.id,
    userId: event.user_id,
    sessionId: event.session_id,
    type: event.event_type,
    severity: event.severity,
    payload: event.payload,
    createdAt: event.created_at,
  };
}

// ─── Outbox: insert + mark delivered ─────────────────────────────────────

async function insertEvent(input: SocEventInput): Promise<StoredSocEvent> {
  const id = randomUUID();
  const severity = input.severity ?? "info";

  // Idempotent insert: if the key is already taken we fetch the existing row
  // instead of creating a second record.
  const inserted = await pool.query<StoredSocEvent>(
    `
    INSERT INTO soc_events
      (id, user_id, session_id, event_type, severity, payload, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
    `,
    [
      id,
      input.userId,
      input.sessionId ?? null,
      input.type,
      severity,
      input.payload,
      input.idempotencyKey ?? null,
    ],
  );

  if (inserted.rows[0]) return inserted.rows[0];

  // Conflict on idempotency_key — fetch the previously inserted row.
  const existing = await pool.query<StoredSocEvent>(
    `SELECT * FROM soc_events WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  return existing.rows[0];
}

async function markDelivered(
  id: string,
  via: "socket" | "webhook" | "backlog",
): Promise<void> {
  await pool.query(
    `UPDATE soc_events
       SET delivered_at = NOW(),
           delivered_via = $2,
           last_attempt_at = NOW()
     WHERE id = $1 AND delivered_at IS NULL`,
    [id, via],
  );
}

async function markAttempt(id: string, error: string | null): Promise<void> {
  await pool.query(
    `UPDATE soc_events
       SET attempts = attempts + 1,
           last_attempt_at = NOW(),
           last_error = $2
     WHERE id = $1`,
    [id, error],
  );
}

export async function markSocEventAcked(
  id: string,
  agentId: string | null,
  via: "socket" | "webhook",
): Promise<void> {
  await pool.query(
    `UPDATE soc_events
       SET delivered_at = COALESCE(delivered_at, NOW()),
           delivered_via = COALESCE(delivered_via, $3),
           acked_by = COALESCE($2, 'anonymous')
     WHERE id = $1`,
    [id, agentId, via],
  );
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function dispatchToSoc(input: SocEventInput): Promise<StoredSocEvent> {
  const event = await insertEvent(input);

  // If the idempotency_key already had an accepted row AND it's delivered,
  // don't re-fire fan-out. (Re-firing an already-delivered event would spam
  // the SOC dashboard.)
  if (event.delivered_at) return event;

  try {
    const viaSocket = await deliverViaSocket(event);
    if (viaSocket) {
      await markDelivered(event.id, "socket");
      event.delivered_at = new Date().toISOString();
    }
  } catch (err) {
    await markAttempt(event.id, (err as Error).message).catch(() => {});
  }

  if (!event.delivered_at && WEBHOOK_URL) {
    try {
      const viaWebhook = await deliverViaWebhook(event);
      if (viaWebhook) {
        await markDelivered(event.id, "webhook");
        event.delivered_at = new Date().toISOString();
      } else {
        await markAttempt(event.id, "webhook_non_2xx");
      }
    } catch (err) {
      await markAttempt(event.id, (err as Error).message).catch(() => {});
    }
  }

  return event;
}

/**
 * Replay every undelivered event to a freshly-connected SOC socket.
 *
 * Called from the Socket.IO connection handler when a dashboard client
 * sends `subscribe:soc`. We don't mark rows delivered here — the dashboard
 * is expected to emit `soc:ack` per event once it's been displayed; that's
 * what drops the row out of the pending set. Without the ack loop, a
 * rapidly-reconnecting dashboard would silently lose events.
 */
export async function flushPendingSocEventsTo(
  socket: Socket,
  _agentId: string | null,
): Promise<void> {
  const { rows } = await pool.query<StoredSocEvent>(
    `SELECT * FROM soc_events
       WHERE delivered_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
    [SOC_RETRY_BATCH_SIZE * 5], // generous cap for cold-start backlog
  );

  if (rows.length === 0) return;

  socket.emit("soc:backlog:begin", { count: rows.length });
  for (const row of rows) {
    socket.emit(SOC_EVENT, serializeForWire(row));
  }
  socket.emit("soc:backlog:end", { count: rows.length });
}

// ─── Retry worker ────────────────────────────────────────────────────────

let retryHandle: NodeJS.Timeout | null = null;

async function runRetryCycle(): Promise<void> {
  const { rows } = await pool.query<StoredSocEvent>(
    `SELECT * FROM soc_events
       WHERE delivered_at IS NULL
         AND attempts < $2
       ORDER BY created_at ASC
       LIMIT $1`,
    [SOC_RETRY_BATCH_SIZE, SOC_MAX_ATTEMPTS],
  );

  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      const viaSocket = await deliverViaSocket(row);
      if (viaSocket) {
        await markDelivered(row.id, "socket");
        continue;
      }
      if (WEBHOOK_URL) {
        const viaWebhook = await deliverViaWebhook(row);
        if (viaWebhook) {
          await markDelivered(row.id, "webhook");
          continue;
        }
      }
      await markAttempt(row.id, "retry_no_transport_available");
    } catch (err) {
      await markAttempt(row.id, (err as Error).message).catch(() => {});
    }
  }
}

export function startSocRetryWorker(): void {
  if (retryHandle) return;
  retryHandle = setInterval(() => {
    runRetryCycle().catch((err) => {
      console.error("[SOC] retry cycle failed:", (err as Error).message);
    });
  }, SOC_RETRY_INTERVAL_MS);
  console.log(
    `[SOC] retry worker started (every ${SOC_RETRY_INTERVAL_MS / 1000}s, batch=${SOC_RETRY_BATCH_SIZE}, max_attempts=${SOC_MAX_ATTEMPTS})`,
  );
}

export function stopSocRetryWorker(): void {
  if (retryHandle) {
    clearInterval(retryHandle);
    retryHandle = null;
  }
}

// ─── Read helpers for the REST surface ───────────────────────────────────

export async function listRecentSocEvents(limit = 50, offset = 0) {
  const { rows } = await pool.query<StoredSocEvent>(
    `SELECT * FROM soc_events
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(serializeForWire);
}

export async function listPendingSocEvents(limit = 100) {
  const { rows } = await pool.query<StoredSocEvent>(
    `SELECT * FROM soc_events
       WHERE delivered_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
    [limit],
  );
  return rows.map(serializeForWire);
}
