#!/usr/bin/env node
/**
 * Fake GPS simulator — walks along a route, then gradually deviates.
 *
 * Usage:
 *   node simulator.js                          # uses defaults
 *   node simulator.js --url http://localhost:9001
 *   node simulator.js --user sim-driver-1
 *   node simulator.js --interval 3000          # ms between pings
 *
 * What it does:
 *   1. Sets a destination via POST /destination/:id/set
 *   2. Sends pings along the OSRM route (on-route phase)
 *   3. Gradually drifts off the route perpendicular to travel direction
 *   4. Keeps going off-route so the dashboard sees the red alert
 *   5. Returns to route (resolution phase)
 *   6. Sends POST /:id/stop at the end
 */

const DEFAULTS = {
  url: "https://rewp2-production.up.railway.app",
  userId: "sim-driver-1",
  intervalMs: 3000,

  // Guwahati area — origin and destination
  origin:      { lat: 26.1445, lng: 91.7362 },   // Paltan Bazaar
  destination: { lat: 26.1158, lng: 91.7086 },   // Maligaon

  onRoutePings:   15,  // pings on-route before deviating
  deviationPings: 20,  // 20 pings × 25m = 500m total — well past 260m outer corridor
  returnPings:    5,   // pings returning to route
};

// ── Parse CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL = getArg("url",      DEFAULTS.url);
const USER_ID  = getArg("user",     DEFAULTS.userId);
const INTERVAL = parseInt(getArg("interval", String(DEFAULTS.intervalMs)), 10);

// ── Helpers ─────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Simple linear interpolation between two lat/lng points
function interpolate(p1, p2, t) {
  return {
    lat: p1.lat + (p2.lat - p1.lat) * t,
    lng: p1.lng + (p2.lng - p1.lng) * t,
  };
}

// Add random GPS noise (metres → degrees, rough equatorial conversion)
function addNoise(point, noiseMetres = 10) {
  const noiseDeg = noiseMetres / 111000;
  return {
    lat: point.lat + (Math.random() - 0.5) * 2 * noiseDeg,
    lng: point.lng + (Math.random() - 0.5) * 2 * noiseDeg,
  };
}

/**
 * Compute the bearing (radians) of the route at the given index.
 * Used to derive a perpendicular bearing for deviation.
 */
function routeBearing(route, idx) {
  const a = route[Math.max(0, idx - 1)];
  const b = route[Math.min(route.length - 1, idx + 1)];
  const dLat = b.lat - a.lat;
  const dLng = b.lng - a.lng;
  return Math.atan2(dLng, dLat); // bearing in radians (north = 0)
}

let sequence = 0;
const sessionId = `sim-${USER_ID}-${Date.now().toString(36)}`;

async function sendPing(lat, lng, moving = true) {
  sequence++;
  const body = {
    lat,
    lng,
    accuracy:     15 + Math.random() * 10,
    speed:        moving ? 5 + Math.random() * 10 : 0,
    heading:      Math.random() * 360,
    moving,
    distance:     moving ? 10 + Math.random() * 20 : 0,
    activity:     moving ? "Driving" : "Stationary",
    timestamp:    Date.now(),
    source:       "simulator",
    appState:     "foreground",
    sequence,
    sessionId,
    driverId:     USER_ID,
    gpsIntervalMs: INTERVAL,
  };

  return post(`/${USER_ID}/ping`, body);
}

// ── Main simulation ─────────────────────────────────────────────────

async function run() {
  console.log(`\n🚀 Simulator starting`);
  console.log(`   Backend:     ${BASE_URL}`);
  console.log(`   User:        ${USER_ID}`);
  console.log(`   Session:     ${sessionId}`);
  console.log(`   Interval:    ${INTERVAL}ms`);
  console.log(`   Origin:      ${DEFAULTS.origin.lat}, ${DEFAULTS.origin.lng}`);
  console.log(`   Destination: ${DEFAULTS.destination.lat}, ${DEFAULTS.destination.lng}`);
  console.log();

  // ── Step 1: Set destination ───────────────────────────────────────
  console.log("📍 Setting destination...");
  const destResult = await post(`/destination/${USER_ID}/set`, {
    origin:      DEFAULTS.origin,
    destination: DEFAULTS.destination,
    name:        "Maligaon (Simulator)",
  });
  console.log(
    `   Route: ${destResult.routePoints} pts | ` +
    `${(destResult.distance / 1000).toFixed(1)}km | ` +
    `${Math.round(destResult.duration / 60)}min`
  );
  console.log();

  // ── Step 2: Fetch the route to walk along ─────────────────────────
  const destInfo = await get(`/destination/${USER_ID}?includeRoute=true`);
  const route = destInfo.route || [];
  if (route.length < 2) {
    console.error("❌ No route returned from backend. Aborting.");
    return;
  }
  console.log(`📐 Got ${route.length} route points to follow\n`);

  // ── Step 3: On-route phase ────────────────────────────────────────
  console.log("🟢 PHASE 1: Following route (on-route)");

  const step = Math.max(1, Math.floor(route.length / DEFAULTS.onRoutePings));
  let lastRouteIdx   = 0;
  let lastOnRoutePt  = route[0];

  for (let i = 0; i < DEFAULTS.onRoutePings && i * step < route.length; i++) {
    const idx = Math.min(i * step, route.length - 1);
    const pt  = addNoise(route[idx], 8);
    lastOnRoutePt = route[idx];
    lastRouteIdx  = idx;

    const result = await sendPing(pt.lat, pt.lng, true);
    const dev    = result.deviationAlert;
    const status = dev
      ? `🚨 DEVIATION (streak=${dev.consecutive})`
      : `✅ OK`;

    console.log(`   #${sequence} → ${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)} | ${status}`);
    await sleep(INTERVAL);
  }

  // ── Step 4: Deviation phase ───────────────────────────────────────
  // FIX: Was using bearing = Math.PI / 4 (45° NE) which walked back along
  // the SW-trending route, keeping the simulator inside the pre-built H3
  // corridor indefinitely.
  //
  // Now we compute the actual route bearing at the last on-route point and
  // deviate PERPENDICULAR to it (rotate 90° clockwise = add π/2).
  // This guarantees we leave the corridor regardless of route direction.
  console.log("\n🔴 PHASE 2: Gradually deviating from route (perpendicular)");

  const travelBearing     = routeBearing(route, lastRouteIdx);
  const perpendicularBearing = travelBearing + Math.PI / 2; // 90° clockwise deviation

  const stepMetres = 25; // Small enough to pass Kalman spike filter (MAX_JUMP=300m)
  const stepDeg    = stepMetres / 111000;

  let currentPoint = { ...lastOnRoutePt };
  let totalOffset  = 0;

  for (let i = 0; i < DEFAULTS.deviationPings; i++) {
    totalOffset += stepMetres;
    currentPoint = {
      lat: currentPoint.lat + stepDeg * Math.cos(perpendicularBearing),
      lng: currentPoint.lng + stepDeg * Math.sin(perpendicularBearing),
    };
    const pt = addNoise(currentPoint, 5);

    const result   = await sendPing(pt.lat, pt.lng, true);
    const dev      = result.deviationAlert;
    const filtered = result.filtered;

    const status = dev
      ? `🚨 DEVIATION (streak=${dev.consecutive})`
      : filtered
        ? `🔄 filtered (spike)`
        : `⚠️  drift ~${totalOffset}m`;

    console.log(
      `   #${sequence} → ${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)} | ~${totalOffset}m off | ${status}`
    );
    await sleep(INTERVAL);
  }

  // ── Step 5: Return phase ──────────────────────────────────────────
  console.log("\n🟡 PHASE 3: Returning to route");

  const lastDrifted = { ...currentPoint };
  for (let i = 0; i < DEFAULTS.returnPings; i++) {
    const t        = (i + 1) / DEFAULTS.returnPings;
    const returning = interpolate(lastDrifted, lastOnRoutePt, t);
    const pt       = addNoise(returning, 8);

    const result = await sendPing(pt.lat, pt.lng, true);
    const dev    = result.deviationAlert;
    const status = dev
      ? `🚨 DEVIATION (streak=${dev.consecutive})`
      : `✅ BACK ON ROUTE`;

    console.log(`   #${sequence} → ${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)} | ${status}`);
    await sleep(INTERVAL);
  }

  // ── Step 6: Stop tracking ─────────────────────────────────────────
  console.log("\n⏹️  Stopping tracking...");
  const stopResult = await post(`/${USER_ID}/stop`, {});
  console.log(`   Session saved: ${stopResult.ok ? "✅" : "❌"}`);
  console.log("\n🏁 Simulation complete!\n");
}

run().catch((err) => {
  console.error("💥 Simulator error:", err.message);
  process.exit(1);
});