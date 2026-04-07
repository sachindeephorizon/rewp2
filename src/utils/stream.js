const normalizeToken = (value, fallback = "unknown") => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const normalized = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || fallback;
};

const buildStreamMetadata = ({ userId, sessionId, rideChannel, driverId }) => {
  const safeUserId = normalizeToken(userId, "user");
  const safeDriverId = normalizeToken(driverId || userId, safeUserId);
  const safeSessionId = normalizeToken(sessionId, null);
  const normalizedRideChannel = normalizeToken(rideChannel, null);
  const streamKey = normalizedRideChannel || (safeSessionId
    ? `stream:${safeUserId}:${safeSessionId}`
    : `stream:${safeUserId}:live`);

  const roomNames = Array.from(new Set([
    streamKey,
    `user:${safeUserId}`,
    `driver:${safeDriverId}`,
    safeSessionId ? `session:${safeSessionId}` : null,
    normalizedRideChannel,
  ].filter(Boolean)));

  return {
    userId: safeUserId,
    driverId: safeDriverId,
    sessionId: safeSessionId,
    rideChannel: normalizedRideChannel,
    streamKey,
    roomNames,
  };
};

module.exports = {
  normalizeToken,
  buildStreamMetadata,
};
