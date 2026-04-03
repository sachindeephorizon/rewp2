/**
 * Road snapping using OSRM's nearest API (free, no API key).
 * Snaps a GPS coordinate to the nearest road segment.
 * Falls back to original coordinates on failure — never blocks.
 */

const OSRM_BASE = "https://router.project-osrm.org";
const SNAP_TIMEOUT_MS = 3000;
const SNAP_RADIUS = 30; // meters — max distance to snap

/**
 * Snap a single point to the nearest road.
 * @param {number} lat
 * @param {number} lng
 * @returns {{ lat: number, lng: number, snapped: boolean }}
 */
async function snapToRoad(lat, lng) {
  try {
    const url = `${OSRM_BASE}/nearest/v1/driving/${lng},${lat}?number=1`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SNAP_TIMEOUT_MS),
    });

    if (!res.ok) return { lat, lng, snapped: false };

    const data = await res.json();
    if (data.code !== "Ok" || !data.waypoints || data.waypoints.length === 0) {
      return { lat, lng, snapped: false };
    }

    const wp = data.waypoints[0];
    // Only snap if the road is within SNAP_RADIUS
    if (wp.distance > SNAP_RADIUS) {
      return { lat, lng, snapped: false };
    }

    return {
      lat: wp.location[1],
      lng: wp.location[0],
      snapped: true,
    };
  } catch {
    return { lat, lng, snapped: false };
  }
}

/**
 * Snap multiple points using OSRM's match API (trajectory matching).
 * More accurate than nearest — considers the route as a whole.
 * @param {Array<{lat: number, lng: number, timestamp?: string}>} points
 * @returns {Array<{lat: number, lng: number}>}
 */
async function snapTrajectory(points) {
  if (!points || points.length < 2) return points;

  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const radiuses = points.map(() => SNAP_RADIUS).join(";");
    const timestamps = points
      .map((p) => Math.floor(new Date(p.timestamp || Date.now()).getTime() / 1000))
      .join(";");

    const url = `${OSRM_BASE}/match/v1/driving/${coords}?radiuses=${radiuses}&timestamps=${timestamps}&geometries=geojson&overview=full`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return points;

    const data = await res.json();
    if (data.code !== "Ok" || !data.matchings || data.matchings.length === 0) {
      return points;
    }

    // Extract snapped coordinates from the matched geometry
    const snappedCoords = data.matchings[0].geometry.coordinates;
    return snappedCoords.map((c) => ({ lat: c[1], lng: c[0] }));
  } catch {
    return points;
  }
}

module.exports = { snapToRoad, snapTrajectory };
