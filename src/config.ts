export const LOCATION_TTL = 3600;
export const SESSION_TTL = 86400;
export const TRAIL_MIN_DISTANCE = 5;
export const CHANNEL = "location_updates";
export const ACTIVE_SET = "active_users";
export const SOCKET_GLOBAL_EVENT = "locationUpdate";
export const SOCKET_STREAM_EVENT = "stream:update";
export const SOCKET_STOP_EVENT = "stream:stop";
export const GLOBAL_EMIT_INTERVAL_MS = 2000;

// ── SOC dispatch ──────────────────────────────────────────────────────
// Dashboard clients join this room after authenticating.
export const SOC_ROOM = "soc:dashboard";
// Socket event name for every SOC event (escalation, tier shift, etc.).
export const SOC_EVENT = "soc:event";
// Ack event sent back from dashboard — "I have displayed/handled this id".
export const SOC_ACK_EVENT = "soc:ack";
// Retry worker cadence + limits for unacked/queued events.
export const SOC_RETRY_INTERVAL_MS = 30_000;
export const SOC_RETRY_BATCH_SIZE = 100;
export const SOC_MAX_ATTEMPTS = 50;
