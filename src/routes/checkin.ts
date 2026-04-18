import express, { Router, Request, Response } from 'express';
import { sessionStore } from './entry';

const router: Router = express.Router();

const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:3001';

// ── Tier config ──
// Tier 1 (Passive):   smooth trip, check every 30 min — cell-tower / low-power
// Tier 2 (Active):    short deviation OR inactivity, check every 15 min — balanced GPS
// Tier 3 (Emergency): long deviation OR missed check-in, every 5 min — full GPS
export const TIER_CONFIG = {
  1: { name: 'passive',   interval_minutes: 1, countdown_seconds: 30 },
  2: { name: 'active',    interval_minutes: 1, countdown_seconds: 30 },
  3: { name: 'emergency', interval_minutes: 1, countdown_seconds: 30 },
} as const;

export type Tier = 1 | 2 | 3;

interface CheckinSession {
  user_id: string;
  tier: Tier;
  interval_minutes: number;
  countdown_seconds: number;
  last_checkin_at: string | null;
  next_checkin_at: string | null;
  last_response: 'safe' | 'need_help' | 'missed' | 'pending';
  checkin_count: number;
  missed_count: number;
  active: boolean;
  tier_history: { tier: Tier; tier_name: string; reason: string; at: string }[];
}

// In-memory store
export const checkinStore: Record<string, CheckinSession> = {};

// Helper: calculate next check-in time
function calcNextCheckin(intervalMin: number): string {
  return new Date(Date.now() + intervalMin * 60000).toISOString();
}

// Helper: shift tier and notify location service
export async function shiftTier(session: CheckinSession, newTier: Tier, reason: string) {
  session.tier = newTier;
  session.interval_minutes = TIER_CONFIG[newTier].interval_minutes;
  session.next_checkin_at = calcNextCheckin(session.interval_minutes);
  session.tier_history.push({
    tier: newTier,
    tier_name: TIER_CONFIG[newTier].name,
    reason,
    at: new Date().toISOString()
  });

  // Add to session timeline if exists
  const entrySession = sessionStore[session.user_id];
  if (entrySession) {
    entrySession.timeline.push({
      time: new Date().toISOString(),
      event: `Tier shifted to ${TIER_CONFIG[newTier].name} (${reason})`,
      type: newTier === 3 ? 'danger' : newTier === 2 ? 'warning' : 'success'
    });
  }

  // Notify location service about tier change
  try {
    await fetch(`${LOCATION_SERVICE_URL}/tracking/${session.user_id}/tier`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: session.user_id,
        new_tier: newTier,
        tier_name: TIER_CONFIG[newTier].name,
        reason
      })
    });
  } catch (err) {
    console.error('Could not notify location service about tier change:', err);
  }
}

// ── POST /handling/checkin/:user_id/start ──
// Start check-in cycle at Tier 1 (passive, 30 min)
router.post('/checkin/:user_id/start', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  checkinStore[user_id] = {
    user_id,
    tier: 1,
    interval_minutes: TIER_CONFIG[1].interval_minutes,
    countdown_seconds: TIER_CONFIG[1].countdown_seconds,
    last_checkin_at: null,
    next_checkin_at: calcNextCheckin(TIER_CONFIG[1].interval_minutes),
    last_response: 'pending',
    checkin_count: 0,
    missed_count: 0,
    active: true,
    tier_history: [{ tier: 1, tier_name: 'passive', reason: 'session_started', at: new Date().toISOString() }]
  };

  res.json({
    user_id,
    tier: 1,
    tier_name: 'passive',
    interval_minutes: TIER_CONFIG[1].interval_minutes,
    countdown_seconds: TIER_CONFIG[1].countdown_seconds,
    next_checkin_at: checkinStore[user_id].next_checkin_at,
    message: 'Check-in cycle started at Tier 1 (passive)',
    timestamp: new Date().toISOString()
  });
});

// ── Screen 4A → POST /handling/checkin/:user_id/respond ──
// User taps "Yes, I'm Safe" or "I Need Help"
router.post('/checkin/:user_id/respond', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;
  const { is_safe } = req.body;

  const session = checkinStore[user_id];
  if (!session || !session.active) {
    return res.status(404).json({ error: 'No active check-in session' });
  }

  if (typeof is_safe !== 'boolean') {
    return res.status(400).json({ error: 'is_safe (boolean) is required' });
  }

  session.last_checkin_at = new Date().toISOString();
  session.checkin_count += 1;
  session.missed_count = 0;

  // Add to session timeline
  const entrySession = sessionStore[user_id];

  if (is_safe) {
    // ✅ "Yes, I'm Safe" — de-escalate to Tier 1
    session.last_response = 'safe';

    if (session.tier > 1) {
      await shiftTier(session, 1, 'user_confirmed_safe');
    }

    session.next_checkin_at = calcNextCheckin(session.interval_minutes);

    if (entrySession) {
      entrySession.timeline.push({
        time: new Date().toISOString(),
        event: 'Check-in confirmed ✓',
        type: 'success'
      });
    }

    res.json({
      user_id,
      status: 'safe',
      tier: session.tier,
      tier_name: TIER_CONFIG[session.tier].name,
      interval_minutes: session.interval_minutes,
      next_checkin_at: session.next_checkin_at,
      checkin_count: session.checkin_count,
      message: 'Safe confirmed. Back to normal monitoring.',
      timestamp: new Date().toISOString()
    });
  } else {
    // 🚨 "I Need Help" — escalate to Tier 3 + trigger escalation
    session.last_response = 'need_help';

    if (session.tier < 3) {
      await shiftTier(session, 3, 'user_needs_help');
    }

    if (entrySession) {
      entrySession.timeline.push({
        time: new Date().toISOString(),
        event: 'User reported: I Need Help',
        type: 'danger'
      });
      entrySession.safety_signals.soc = 'alerted';
    }

    res.json({
      user_id,
      status: 'need_help',
      tier: 3,
      tier_name: 'emergency',
      interval_minutes: TIER_CONFIG[3].interval_minutes,
      trigger_escalation: true,
      alert: {
        type: 'NEED_HELP',
        message: `User ${user_id} tapped "I Need Help"`,
        triggered_at: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });
  }
});

// ── Screen 4A → POST /handling/checkin/:user_id/extend ──
// "Need more time? Extend session"
router.post('/checkin/:user_id/extend', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;
  const { extra_minutes } = req.body;

  const session = checkinStore[user_id];
  if (!session || !session.active) {
    return res.status(404).json({ error: 'No active check-in session' });
  }

  const extension = extra_minutes || 15;
  session.next_checkin_at = calcNextCheckin(extension);

  const entrySession = sessionStore[user_id];
  if (entrySession) {
    entrySession.timeline.push({
      time: new Date().toISOString(),
      event: `Session extended by ${extension} min`,
      type: 'info'
    });
  }

  res.json({
    user_id,
    extended_by_minutes: extension,
    next_checkin_at: session.next_checkin_at,
    message: `Next check-in extended by ${extension} minutes`,
    timestamp: new Date().toISOString()
  });
});

// ── POST /handling/checkin/:user_id/inactivity ──
// Location service reports user is stationary → Tier 1 → Tier 2
router.post('/checkin/:user_id/inactivity', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const session = checkinStore[user_id];
  if (!session || !session.active) {
    return res.status(404).json({ error: 'No active check-in session' });
  }

  // Update safety signal
  const entrySession = sessionStore[user_id];
  if (entrySession) {
    entrySession.safety_signals.movement = 'stationary';
  }

  if (session.tier === 1) {
    await shiftTier(session, 2, 'inactivity_detected');
  }

  res.json({
    user_id,
    tier: session.tier,
    tier_name: TIER_CONFIG[session.tier].name,
    interval_minutes: session.interval_minutes,
    next_checkin_at: session.next_checkin_at,
    message: session.tier === 2 ? 'Escalated to Tier 2 (active) due to inactivity' : `Already at tier ${session.tier}`,
    timestamp: new Date().toISOString()
  });
});

// ── POST /handling/checkin/:user_id/missed ──
// 30-second countdown expired, user didn't respond → escalate
router.post('/checkin/:user_id/missed', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const session = checkinStore[user_id];
  if (!session || !session.active) {
    return res.status(404).json({ error: 'No active check-in session' });
  }

  session.last_response = 'missed';
  session.missed_count += 1;

  const entrySession = sessionStore[user_id];
  if (entrySession) {
    entrySession.timeline.push({
      time: new Date().toISOString(),
      event: `Check-in missed (${session.missed_count} total)`,
      type: 'danger'
    });
    entrySession.safety_signals.soc = 'alerted';
  }

  // Escalate to next tier
  if (session.tier < 3) {
    const newTier = (session.tier + 1) as Tier;
    await shiftTier(session, newTier, 'missed_checkin');
  }

  res.json({
    user_id,
    status: 'missed',
    tier: session.tier,
    tier_name: TIER_CONFIG[session.tier].name,
    interval_minutes: session.interval_minutes,
    missed_count: session.missed_count,
    trigger_escalation: session.tier === 3,
    next_checkin_at: session.next_checkin_at,
    timestamp: new Date().toISOString()
  });
});

// ── GET /handling/checkin/:user_id/status ──
router.get('/checkin/:user_id/status', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const session = checkinStore[user_id];
  if (!session) {
    return res.status(404).json({ error: 'No check-in session found' });
  }

  res.json({
    user_id,
    active: session.active,
    tier: session.tier,
    tier_name: TIER_CONFIG[session.tier].name,
    interval_minutes: session.interval_minutes,
    countdown_seconds: session.countdown_seconds,
    next_checkin_at: session.next_checkin_at,
    last_response: session.last_response,
    checkin_count: session.checkin_count,
    missed_count: session.missed_count,
    last_checkin_at: session.last_checkin_at,
    tier_history: session.tier_history
  });
});

// ── PUT /handling/checkin/:user_id/stop ──
router.put('/checkin/:user_id/stop', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const session = checkinStore[user_id];
  if (!session) {
    return res.status(404).json({ error: 'No check-in session found' });
  }

  session.active = false;

  res.json({
    user_id,
    message: 'Check-in cycle stopped',
    final_tier: session.tier,
    total_checkins: session.checkin_count,
    total_missed: session.missed_count,
    tier_history: session.tier_history,
    timestamp: new Date().toISOString()
  });
});

// ── Internal helpers used by tracking.ts (no HTTP round-trip) ──────────────

/**
 * Lazily create a check-in session if one doesn't already exist for this user.
 * Used by the tracking pipeline so a tier shift never silently no-ops on a
 * user who started monitoring without explicitly hitting /checkin/start.
 */
function ensureCheckinSession(userId: string): CheckinSession {
  const existing = checkinStore[userId];
  if (existing && existing.active) return existing;
  const fresh: CheckinSession = {
    user_id: userId,
    tier: 1,
    interval_minutes: TIER_CONFIG[1].interval_minutes,
    countdown_seconds: TIER_CONFIG[1].countdown_seconds,
    last_checkin_at: null,
    next_checkin_at: calcNextCheckin(TIER_CONFIG[1].interval_minutes),
    last_response: 'pending',
    checkin_count: 0,
    missed_count: 0,
    active: true,
    tier_history: [
      { tier: 1, tier_name: 'passive', reason: 'auto_created_by_tracking', at: new Date().toISOString() },
    ],
  };
  checkinStore[userId] = fresh;
  return fresh;
}

/**
 * Bump tier when the location pipeline observes a stationary user.
 * Tier 1 → Tier 2. Idempotent for users already at T2/T3.
 */
export async function escalateOnInactivity(userId: string): Promise<Tier> {
  const session = ensureCheckinSession(userId);
  if (session.tier === 1) {
    await shiftTier(session, 2, 'inactivity_detected');
  }
  return session.tier;
}

/**
 * Bump tier on a route deviation. severity drives the target tier:
 *   short → at least Tier 2
 *   long  → Tier 3
 */
export async function escalateOnDeviation(
  userId: string,
  severity: 'short' | 'long',
): Promise<Tier> {
  const session = ensureCheckinSession(userId);
  const target: Tier = severity === 'long' ? 3 : 2;
  if (session.tier < target) {
    await shiftTier(
      session,
      target,
      severity === 'long' ? 'long_route_deviation' : 'short_route_deviation',
    );
  }
  return session.tier;
}

/**
 * Read tier + next_checkin_at for the ping response. Lazily creates a
 * Tier-1 session on first call so the client gets a live countdown from
 * the very first ping (instead of falling back to its hardcoded default).
 */
export function getCheckinSnapshot(userId: string): {
  tier: Tier;
  tier_name: string;
  interval_minutes: number;
  next_checkin_at: string | null;
} {
  const s = ensureCheckinSession(userId);
  return {
    tier: s.tier,
    tier_name: TIER_CONFIG[s.tier].name,
    interval_minutes: s.interval_minutes,
    next_checkin_at: s.next_checkin_at,
  };
}

export default router;