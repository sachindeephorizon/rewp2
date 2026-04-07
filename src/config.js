module.exports = {
  LOCATION_TTL: 3600,
  SESSION_TTL: 86400,
  TRAIL_MIN_DISTANCE: 5,
  CHANNEL: "location_updates",
  ACTIVE_SET: "active_users",
  SOCKET_GLOBAL_EVENT: "locationUpdate",
  SOCKET_STREAM_EVENT: "stream:update",
  SOCKET_STOP_EVENT: "stream:stop",
  GLOBAL_EMIT_INTERVAL_MS: 2000,
};
