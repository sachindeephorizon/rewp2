import express, { Router, Request, Response } from 'express';
import { resetCheckinForUser } from './checkin';

const router: Router = express.Router();

const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:3001';

// ── Session types ──

interface TimelineEvent {
  time: string;
  event: string;
  type: 'info' | 'warning' | 'success' | 'danger';
}

interface Session {
  user_id: string;
  session_id: string;
  status: 'active' | 'ended';

  // Added later via /details (Screen 2 — Quick Start)
  destination: { name: string; lat: number; long: number } | null;
  trip_type: 'cab' | 'walking' | 'meeting' | 'custom' | null;
  trusted_contacts: { name: string; relation: string; notify: boolean }[];

  // Tracking stats (Screen 3 — Dashboard)
  started_at: string;
  ended_at: string | null;
  distance_covered_km: number;
  elapsed_minutes: number;
  eta_minutes: number | null;

  // Safety signals
  safety_signals: {
    route: 'normal' | 'deviated';
    movement: 'active' | 'stationary';
    speed: 'normal' | 'check';
    soc: 'watching' | 'alerted';
  };

  timeline: TimelineEvent[];
}

// In-memory session store
export const sessionStore: Record<string, Session> = {};

// ── Screen 1 → POST /handling/entry ──
// One-tap start. Monitoring begins IMMEDIATELY. No wizard gate.
router.post('/entry', async (req: Request, res: Response) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  // Wipe any leftover check-in state from a previous session. Without this,
  // a stale `checkinStore[userId]` with overdue `next_checkin_at` triggers
  // the overdue-detection in getCheckinSnapshot on the first ping of this
  // new session — escalation fires instantly, which is obviously wrong.
  resetCheckinForUser(user_id);

  const session_id = `session_${user_id}_${Date.now()}`;

  sessionStore[user_id] = {
    user_id,
    session_id,
    status: 'active',
    destination: null,
    trip_type: null,
    trusted_contacts: [],
    started_at: new Date().toISOString(),
    ended_at: null,
    distance_covered_km: 0,
    elapsed_minutes: 0,
    eta_minutes: null,
    safety_signals: {
      route: 'normal',
      movement: 'active',
      speed: 'normal',
      soc: 'watching'
    },
    timeline: [
      { time: new Date().toISOString(), event: 'Monitoring started', type: 'info' }
    ]
  };

  // Tell Location Service to start tracking immediately
  try {
    await fetch(`${LOCATION_SERVICE_URL}/tracking/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id })
    });
  } catch (err) {
    console.error('Could not start tracking session:', err);
  }

  res.json({
    user_id,
    session_id,
    status: 'active',
    message: 'Monitoring started immediately',
    started_at: sessionStore[user_id].started_at
  });
});

// ── Screen 2 → PUT /handling/entry/:user_id/details ──
// User adds context WHILE session is already live
router.put('/entry/:user_id/details', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;
  const { destination, trip_type, trusted_contacts } = req.body;

  const session = sessionStore[user_id];
  if (!session || session.status !== 'active') {
    return res.status(404).json({ error: 'No active session' });
  }

  if (destination) {
    session.destination = destination;
    session.timeline.push({
      time: new Date().toISOString(),
      event: `Destination set: ${destination.name}`,
      type: 'info'
    });

    // Tell Location Service about destination for route tracking
    try {
      await fetch(`${LOCATION_SERVICE_URL}/tracking/${user_id}/destination`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: destination.lat, long: destination.long })
      });
    } catch (err) {
      console.error('Could not update destination in location service:', err);
    }
  }

  if (trip_type) {
    session.trip_type = trip_type;
    session.timeline.push({
      time: new Date().toISOString(),
      event: `Trip type: ${trip_type}`,
      type: 'info'
    });
  }

  if (trusted_contacts) {
    session.trusted_contacts = trusted_contacts;
  }

  res.json({
    user_id,
    session_id: session.session_id,
    destination: session.destination,
    trip_type: session.trip_type,
    trusted_contacts: session.trusted_contacts,
    message: 'Session details updated',
    timestamp: new Date().toISOString()
  });
});

// ── Screen 3 → GET /handling/entry/:user_id/dashboard ──
// Active monitoring dashboard — merges session data + live location data
router.get('/entry/:user_id/dashboard', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const session = sessionStore[user_id];
  if (!session) {
    return res.status(404).json({ error: 'No session found' });
  }

  // Calculate elapsed time
  const startTime = new Date(session.started_at).getTime();
  const now = Date.now();
  session.elapsed_minutes = Math.round((now - startTime) / 60000);

  // Fetch live data from Location Service
  interface LiveData {
    distance_covered_km?: number;
    eta_minutes?: number | null;
    route_deviation?: boolean;
    stationary?: boolean;
    speed_alert?: boolean;
    live_location?: unknown;
  }
  let liveData: LiveData | null = null;
  try {
    const locationRes = await fetch(`${LOCATION_SERVICE_URL}/tracking/${user_id}/live`);
    if (locationRes.ok) {
      liveData = await locationRes.json() as LiveData;
      session.distance_covered_km = liveData.distance_covered_km ?? session.distance_covered_km;
      session.eta_minutes = liveData.eta_minutes ?? session.eta_minutes;

      // Update safety signals from location data
      if (liveData.route_deviation) session.safety_signals.route = 'deviated';
      if (liveData.stationary) session.safety_signals.movement = 'stationary';
      if (liveData.speed_alert) session.safety_signals.speed = 'check';
    }
  } catch (err) {
    console.error('Could not fetch live data:', err);
  }

  res.json({
    user_id,
    session_id: session.session_id,
    status: session.status,
    elapsed_minutes: session.elapsed_minutes,
    distance_covered_km: session.distance_covered_km,
    eta_minutes: session.eta_minutes,
    destination: session.destination,
    trip_type: session.trip_type,
    safety_signals: session.safety_signals,
    live_location: liveData?.live_location ?? null,
    trusted_contacts: session.trusted_contacts,
    started_at: session.started_at
  });
});

// ── Screen 3 → PUT /handling/entry/:user_id/signal ──
// Update safety signals (from location service or SOC)
router.put('/entry/:user_id/signal', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;
  const { signal, value } = req.body;

  const session = sessionStore[user_id];
  if (!session || session.status !== 'active') {
    return res.status(404).json({ error: 'No active session' });
  }

  const validSignals = ['route', 'movement', 'speed', 'soc'];
  if (!validSignals.includes(signal)) {
    return res.status(400).json({ error: `signal must be one of: ${validSignals.join(', ')}` });
  }

  (session.safety_signals as Record<string, string>)[signal] = value;
  session.timeline.push({
    time: new Date().toISOString(),
    event: `Safety signal: ${signal} → ${value}`,
    type: value === 'normal' || value === 'active' || value === 'watching' ? 'success' : 'warning'
  });

  res.json({
    user_id,
    safety_signals: session.safety_signals,
    timestamp: new Date().toISOString()
  });
});

// ── Screen 3 → PUT /handling/entry/:user_id/end ──
// End monitoring session
router.put('/entry/:user_id/end', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const session = sessionStore[user_id];
  if (!session || session.status !== 'active') {
    return res.status(404).json({ error: 'No active session' });
  }

  session.status = 'ended';
  session.ended_at = new Date().toISOString();

  const startTime = new Date(session.started_at).getTime();
  const endTime = new Date(session.ended_at).getTime();
  session.elapsed_minutes = Math.round((endTime - startTime) / 60000);

  session.timeline.push({
    time: session.ended_at,
    event: `Session ended · ${session.elapsed_minutes} mins`,
    type: 'success'
  });

  // Tell Location Service to stop tracking
  try {
    await fetch(`${LOCATION_SERVICE_URL}/tracking/${user_id}/stop`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Could not stop tracking:', err);
  }

  res.json({
    user_id,
    session_id: session.session_id,
    status: 'ended',
    ended_at: session.ended_at,
    message: 'Monitoring ended'
  });
});

// ── Screen 5A → GET /handling/entry/:user_id/summary ──
// Session complete summary with timeline and stats
router.get('/entry/:user_id/summary', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const session = sessionStore[user_id];
  if (!session) {
    return res.status(404).json({ error: 'No session found' });
  }

  res.json({
    user_id,
    session_id: session.session_id,
    status: session.status,
    destination: session.destination,
    trip_type: session.trip_type,
    stats: {
      elapsed_minutes: session.elapsed_minutes,
      distance_covered_km: session.distance_covered_km,
      total_checkins: session.timeline.filter(e => e.event.includes('Check-in')).length,
      total_escalations: session.timeline.filter(e => e.event.includes('Escalation')).length
    },
    timeline: session.timeline,
    started_at: session.started_at,
    ended_at: session.ended_at,
    trusted_contacts: session.trusted_contacts
  });
});

// ── GET /handling/entry/:user_id/live ──
// Pass through live location from Location Service
router.get('/entry/:user_id/live', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  try {
    const locationRes = await fetch(`${LOCATION_SERVICE_URL}/tracking/${user_id}/live`);
    if (!locationRes.ok) {
      return res.status(locationRes.status).json({ error: 'No active tracking session' });
    }
    const locationData = await locationRes.json();
    res.json(locationData);
  } catch (err) {
    console.error('Could not fetch live location:', err);
    return res.status(502).json({ error: 'Location service unavailable' });
  }
});

// ── POST /handling/entry/:user_id/share ──
// Share trip with family (Screen 3 + 5A)
router.post('/entry/:user_id/share', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;
  const { share_with } = req.body;

  const session = sessionStore[user_id];
  if (!session) {
    return res.status(404).json({ error: 'No session found' });
  }

  session.timeline.push({
    time: new Date().toISOString(),
    event: `Trip shared with ${share_with || 'family'}`,
    type: 'info'
  });

  res.json({
    user_id,
    session_id: session.session_id,
    shared_with: share_with || 'family',
    share_link: `https://deephorizon.io/trip/${session.session_id}`,
    message: 'Trip shared successfully',
    timestamp: new Date().toISOString()
  });
});

export default router;