import express, { Router, Request, Response } from 'express';
import { sessionStore } from './entry';
import { checkinStore, TIER_CONFIG } from './checkin';
import { dispatchToSoc } from '../services/soc.dispatch.service';

const router: Router = express.Router();

// ── Screen 5B: 5-Step Escalation Flow ──
// Step 1: Push notification sent
// Step 2: SMS sent to phone
// Step 3: AI Safety Call
// Step 4: Human SOC Agent
// Step 5: Trusted contacts notified

type StepStatus = 'pending' | 'in_progress' | 'done_no_response' | 'done_responded';

interface EscalationStep {
  step: number;
  name: string;
  status: StepStatus;
  triggered_at: string | null;
  responded_at: string | null;
}

interface Escalation {
  user_id: string;
  escalation_id: string;
  reason: 'missed_checkin' | 'need_help' | 'sos' | 'manual';
  current_step: number;
  steps: EscalationStep[];
  active: boolean;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

// In-memory escalation store
const escalationStore: Record<string, Escalation> = {};

function createSteps(): EscalationStep[] {
  const stepNames = [
    'Push notification sent',
    'SMS sent to phone',
    'AI Safety Call',
    'Human SOC Agent',
    'Trusted contacts notified'
  ];
  return stepNames.map((name, i) => ({
    step: i + 1,
    name,
    status: 'pending' as StepStatus,
    triggered_at: null,
    responded_at: null
  }));
}

// ── POST /handling/escalation/:user_id/trigger ──
// Start 5-step escalation (called when check-in missed or user taps "I Need Help")
router.post('/escalation/:user_id/trigger', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;
  const { reason } = req.body;

  const validReasons = ['missed_checkin', 'need_help', 'sos', 'manual'];
  if (!reason || !validReasons.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${validReasons.join(', ')}` });
  }

  const escalation_id = `esc_${user_id}_${Date.now()}`;
  const steps = createSteps();

  // Start step 1 immediately
  steps[0].status = 'in_progress';
  steps[0].triggered_at = new Date().toISOString();

  escalationStore[user_id] = {
    user_id,
    escalation_id,
    reason,
    current_step: 1,
    steps,
    active: true,
    resolved: false,
    resolved_by: null,
    resolved_at: null,
    created_at: new Date().toISOString()
  };

  // Add to session timeline
  const session = sessionStore[user_id];
  if (session) {
    session.timeline.push({
      time: new Date().toISOString(),
      event: `Escalation triggered: ${reason}`,
      type: 'danger'
    });
    session.safety_signals.soc = 'alerted';
  }

  // Notify SOC — durable + real-time. If the SOC dashboard is down, the
  // outbox row persists and the next connecting dashboard socket drains it.
  dispatchToSoc({
    userId: user_id,
    sessionId: session?.session_id ?? null,
    type: 'escalation_triggered',
    severity: 'critical',
    payload: {
      escalation_id,
      reason,
      current_step: 1,
      current_step_name: 'Push notification sent',
    },
    idempotencyKey: `escalation_triggered:${escalation_id}`,
  }).catch((err) => console.error('[SOC] dispatch failed:', (err as Error).message));

  res.json({
    user_id,
    escalation_id,
    reason,
    current_step: 1,
    current_step_name: 'Push notification sent',
    steps,
    message: 'Escalation started. Step 1: Push notification sent.',
    created_at: escalationStore[user_id].created_at
  });
});

// ── PUT /handling/escalation/:user_id/advance ──
// Advance to next step (called when current step gets no response)
router.put('/escalation/:user_id/advance', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const esc = escalationStore[user_id];
  if (!esc || !esc.active) {
    return res.status(404).json({ error: 'No active escalation' });
  }

  if (esc.current_step >= 5) {
    return res.status(400).json({ error: 'Already at final escalation step (5)' });
  }

  // Mark current step as done (no response)
  esc.steps[esc.current_step - 1].status = 'done_no_response';

  // Advance to next step
  esc.current_step += 1;
  esc.steps[esc.current_step - 1].status = 'in_progress';
  esc.steps[esc.current_step - 1].triggered_at = new Date().toISOString();

  // Add to session timeline
  const session = sessionStore[user_id];
  if (session) {
    session.timeline.push({
      time: new Date().toISOString(),
      event: `Escalation step ${esc.current_step}: ${esc.steps[esc.current_step - 1].name}`,
      type: 'danger'
    });
  }

  dispatchToSoc({
    userId: user_id,
    sessionId: sessionStore[user_id]?.session_id ?? null,
    type: 'escalation_advanced',
    severity: 'critical',
    payload: {
      escalation_id: esc.escalation_id,
      current_step: esc.current_step,
      current_step_name: esc.steps[esc.current_step - 1].name,
      reason: esc.reason,
    },
    idempotencyKey: `escalation_advanced:${esc.escalation_id}:${esc.current_step}`,
  }).catch((err) => console.error('[SOC] dispatch failed:', (err as Error).message));

  // If step 5 — notify trusted contacts from session
  if (esc.current_step === 5) {
    const entrySession = sessionStore[user_id];
    const contacts = entrySession?.trusted_contacts?.filter(c => c.notify) || [];

    res.json({
      user_id,
      escalation_id: esc.escalation_id,
      current_step: esc.current_step,
      current_step_name: esc.steps[esc.current_step - 1].name,
      contacts_notified: contacts.map(c => c.name),
      steps: esc.steps,
      message: `Step 5: Trusted contacts being notified`,
      timestamp: new Date().toISOString()
    });
    return;
  }

  res.json({
    user_id,
    escalation_id: esc.escalation_id,
    current_step: esc.current_step,
    current_step_name: esc.steps[esc.current_step - 1].name,
    steps: esc.steps,
    message: `Advanced to step ${esc.current_step}: ${esc.steps[esc.current_step - 1].name}`,
    timestamp: new Date().toISOString()
  });
});

// ── Screen 5B → PUT /handling/escalation/:user_id/safe ──
// User taps "I'm Safe — Stop Alert"
router.put('/escalation/:user_id/safe', async (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const esc = escalationStore[user_id];
  if (!esc || !esc.active) {
    return res.status(404).json({ error: 'No active escalation' });
  }

  // Resolve escalation
  esc.active = false;
  esc.resolved = true;
  esc.resolved_by = 'user';
  esc.resolved_at = new Date().toISOString();
  esc.steps[esc.current_step - 1].status = 'done_responded';
  esc.steps[esc.current_step - 1].responded_at = new Date().toISOString();

  // De-escalate check-in tier back to 1
  const checkin = checkinStore[user_id];
  if (checkin && checkin.active) {
    checkin.tier = 1;
    checkin.interval_minutes = TIER_CONFIG[1].interval_seconds;
    checkin.missed_count = 0;
    checkin.last_response = 'safe';
    checkin.tier_history.push({
      tier: 1,
      tier_name: 'passive',
      reason: 'escalation_resolved_by_user',
      at: new Date().toISOString()
    });
  }

  // Update session timeline
  const session = sessionStore[user_id];
  if (session) {
    session.timeline.push({
      time: new Date().toISOString(),
      event: 'User confirmed safe — escalation stopped',
      type: 'success'
    });
    session.safety_signals.soc = 'watching';
  }

  dispatchToSoc({
    userId: user_id,
    sessionId: sessionStore[user_id]?.session_id ?? null,
    type: 'escalation_resolved',
    severity: 'info',
    payload: {
      escalation_id: esc.escalation_id,
      resolved_by: 'user',
      stopped_at_step: esc.current_step,
      stopped_at_step_name: esc.steps[esc.current_step - 1].name,
      tier_reset_to: 1,
    },
    idempotencyKey: `escalation_resolved:${esc.escalation_id}`,
  }).catch((err) => console.error('[SOC] dispatch failed:', (err as Error).message));

  res.json({
    user_id,
    escalation_id: esc.escalation_id,
    resolved: true,
    resolved_by: 'user',
    resolved_at: esc.resolved_at,
    stopped_at_step: esc.current_step,
    stopped_at_step_name: esc.steps[esc.current_step - 1].name,
    tier_reset_to: 1,
    message: 'Alert stopped. User confirmed safe. Back to normal monitoring.',
    timestamp: new Date().toISOString()
  });
});

// ── GET /handling/escalation/:user_id/status ──
// Get current escalation state (for Screen 5B UI)
router.get('/escalation/:user_id/status', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const esc = escalationStore[user_id];
  if (!esc) {
    return res.status(404).json({ error: 'No escalation found' });
  }

  const checkin = checkinStore[user_id];

  res.json({
    user_id,
    escalation_id: esc.escalation_id,
    active: esc.active,
    resolved: esc.resolved,
    reason: esc.reason,
    current_step: esc.current_step,
    current_step_name: esc.steps[esc.current_step - 1].name,
    steps: esc.steps,
    current_tier: checkin?.tier ?? null,
    created_at: esc.created_at,
    resolved_at: esc.resolved_at
  });
});

// ── GET /handling/escalation/:user_id/history ──
router.get('/escalation/:user_id/history', (req: Request<{ user_id: string }>, res: Response) => {
  const { user_id } = req.params;

  const esc = escalationStore[user_id];
  if (!esc) {
    return res.json({ user_id, escalations: [] });
  }

  res.json({
    user_id,
    escalation: esc
  });
});

export default router;