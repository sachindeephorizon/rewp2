/**
 * Road snapping using OSRM's nearest API (free, no API key).
 *
 * FIX: SNAP_RADIUS increased from 30m → 50m.
 * Old value caused fallback to raw unsnapped GPS when accuracy was
 * 10-15m and the device was near buildings/flyovers (GPS drift puts
 * the raw point 30-45m from the road → old code returned unsnapped).
 * 50m covers typical urban GPS drift without over-snapping to wrong roads.
 */

const OSRM_BASE = "https://router.project-osrm.org";
const SNAP_TIMEOUT_MS = 3000;
const SNAP_RADIUS = 50; // was 30m — increased to handle urban GPS drift

/**
 * Snap a single point to the nearest road.
 */
async function snapToRoad(lat, lng) {
  try {
    const url = `${OSRM_BASE}/nearest/v1/driving/${lng},${lat}?number=3`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SNAP_TIMEOUT_MS),
    });
    if (!res.ok) return { lat, lng, snapped: false };

    const data = await res.json();
    if (data.code !== "Ok" || !data.waypoints || data.waypoints.length === 0) {
      return { lat, lng, snapped: false };
    }

    // FIX: request 3 nearest waypoints and pick the closest one
    // within SNAP_RADIUS. This handles flyover/underpass ambiguity
    // better than blindly taking the first result.
    const candidates = data.waypoints.filter((wp) => wp.distance <= SNAP_RADIUS);
    if (candidates.length === 0) return { lat, lng, snapped: false };

    // Pick the closest candidate
    const best = candidates.reduce((a, b) => (a.distance < b.distance ? a : b));

    return {
      lat: best.location[1],
      lng: best.location[0],
      snapped: true,
    };
  } catch {
    return { lat, lng, snapped: false };
  }
}

/**
 * Snap multiple points using OSRM's match API (trajectory matching).
 * More accurate than nearest — considers the route as a whole.
 */
async function snapTrajectory(points) {
  if (!points || points.length < 2) return points;

  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");

    // FIX: increased radius from 30 → 50m for all points
    const radiuses = points.map(() => SNAP_RADIUS).join(";");

    const timestamps = points
      .map((p) => Math.floor(new Date(p.timestamp || Date.now()).getTime() / 1000))
      .join(";");

    const url = `${OSRM_BASE}/match/v1/driving/${coords}?radiuses=${radiuses}&timestamps=${timestamps}&geometries=geojson&overview=full&annotations=true`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return points;

    const data = await res.json();

    // OSRM returns 'NoMatch' when points are too scattered — fall back gracefully
    if (data.code !== "Ok" || !data.matchings || data.matchings.length === 0) {
      console.warn("[snapTrajectory] No match found — returning raw points");
      return points;
    }

    const snappedCoords = data.matchings[0].geometry.coordinates;
    return snappedCoords.map((c) => ({ lat: c[1], lng: c[0] }));
  } catch (err) {
    console.warn("[snapTrajectory] Failed:", err.message);
    return points;
  }
}

module.exports = { snapToRoad, snapTrajectory };