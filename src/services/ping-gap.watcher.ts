/**
 * Ping-gap watcher.
 *
 * Android Doze, ColorOS battery kill, and network blackouts can silence a
 * monitored user's location stream for minutes at a time. The dashboard
 * has no way to tell "user is fine and stationary" from "phone is gone
 * dark" without a server-side timeout.
 *
 * This worker scans every active user's last ping timestamp every 30s and
 * publishes a `ping_gap` event when the gap exceeds 90s. It re-fires every
 * cycle while the gap persists, so a freshly-connected dashboard always
 * sees the warning state.
 *
 * The watcher is non-fatal — failures during a cycle are logged and the
 * next cycle retries. It does not modify ACTIVE_SET or any session data.
 */

import { redis } from "../redis";
import { ACTIVE_SET, CHANNEL } from "../config";

const SCAN_INTERVAL_MS = 30_000;
// 90s threshold matches the "longest reasonable gap during a healthy
// session" — T1 cadence is 60s + Doze coalescing slack. Anything longer
// is an outage worth telling SOC about.
const GAP_THRESHOLD_MS = 90_000;

let timer: NodeJS.Timeout | null = null;

async function scanOnce(): Promise<void> {
  try {
    // Pull the whole active set in one call. Even with thousands of users
    // this is a single SMEMBERS — cheap. Each user contributes one GET
    // and at most one PUBLISH.
    const userIds = await redis.sMembers(ACTIVE_SET);
    if (userIds.length === 0) return;

    const now = Date.now();
    for (const userId of userIds) {
      try {
        const raw = await redis.get(`lastPingAt:${userId}`);
        if (!raw) continue;          // never pinged → ignore
        const lastMs = Number(raw);
        if (!Number.isFinite(lastMs)) continue;
        const gapMs = now - lastMs;
        if (gapMs < GAP_THRESHOLD_MS) continue;

        const lastSession = await redis.get(`session:${userId}:meta`);
        const sessionMeta = lastSession ? JSON.parse(lastSession) : null;
        const roomNames: string[] = Array.isArray(sessionMeta?.roomNames)
          ? sessionMeta.roomNames
          : [];

        const event = {
          event: "ping_gap",
          userId,
          lastPingAt: new Date(lastMs).toISOString(),
          gapSeconds: Math.round(gapMs / 1000),
          severity: gapMs > 5 * 60_000 ? "critical" : "warning",
          detectedAt: new Date(now).toISOString(),
          roomNames,
          streamKey: sessionMeta?.streamKey ?? `stream:${userId}:live`,
        };

        await redis.publish(CHANNEL, JSON.stringify(event));
      } catch (innerErr) {
        console.warn(
          `[ping-gap] check failed for ${userId}:`,
          (innerErr as Error).message,
        );
      }
    }
  } catch (err) {
    console.error("[ping-gap] scan failed:", (err as Error).message);
  }
}

export function startPingGapWatcher(): void {
  if (timer) return;
  timer = setInterval(() => {
    scanOnce().catch((e) =>
      console.error("[ping-gap] cycle error:", (e as Error).message),
    );
  }, SCAN_INTERVAL_MS);
  console.log(
    `[ping-gap] watcher started (scan every ${SCAN_INTERVAL_MS / 1000}s, threshold ${GAP_THRESHOLD_MS / 1000}s)`,
  );
}

export function stopPingGapWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
