module.exports = {
  LOCATION_TTL: 300,          // 5 min — buffer for background/offline gaps
  SESSION_TTL: 86400,         // 24 hours — auto-expire stale session data
  TRAIL_MIN_DISTANCE: 5,      // meters — min distance between trail dots
  CHANNEL: "location_updates",
  ACTIVE_SET: "active_users",
};
