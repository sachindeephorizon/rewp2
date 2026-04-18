import type { StreamMetadataInput, StreamMetadata } from "../types";

export function normalizeToken(value: string | number | null | undefined, fallback: string): string;
export function normalizeToken(value: string | number | null | undefined, fallback: null): string | null;
export function normalizeToken(value: string | number | null | undefined, fallback: string | null = "unknown"): string | null {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const normalized = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || fallback;
}

export const buildStreamMetadata = ({
  userId,
  sessionId,
  rideChannel,
  driverId,
}: StreamMetadataInput): StreamMetadata => {
  const safeUserId = normalizeToken(userId, "user");
  const safeDriverId = normalizeToken(driverId || userId, safeUserId);
  const safeSessionId = normalizeToken(sessionId ?? null, null);
  const normalizedRideChannel = normalizeToken(rideChannel ?? null, null);
  const streamKey = normalizedRideChannel || (safeSessionId
    ? `stream:${safeUserId}:${safeSessionId}`
    : `stream:${safeUserId}:live`);

  const roomNames = Array.from(new Set(
    [
      streamKey,
      `user:${safeUserId}`,
      `driver:${safeDriverId}`,
      safeSessionId ? `session:${safeSessionId}` : null,
      normalizedRideChannel,
    ].filter((r): r is string => r !== null)
  ));

  return {
    userId: safeUserId,
    driverId: safeDriverId,
    sessionId: safeSessionId,
    rideChannel: normalizedRideChannel,
    streamKey,
    roomNames,
  };
};
