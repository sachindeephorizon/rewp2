/**
 * Road snapping using OSRM's nearest API (free, no API key).
 *
 * FIX: SNAP_RADIUS increased from 30m → 50m.
 */

import type { LatLng, SnapResult } from "../types";

const OSRM_BASE = "https://router.project-osrm.org";
const SNAP_TIMEOUT_MS = 3000;
const SNAP_RADIUS = 50;

interface OsrmWaypoint {
  location: [number, number];
  distance: number;
}

interface OsrmNearestResponse {
  code: string;
  waypoints?: OsrmWaypoint[];
}

interface OsrmMatchResponse {
  code: string;
  matchings?: Array<{
    geometry: {
      coordinates: [number, number][];
    };
  }>;
}

interface TrajectoryPoint {
  lat: number;
  lng: number;
  timestamp?: string | number;
}

/**
 * Snap a single point to the nearest road.
 */
export async function snapToRoad(lat: number, lng: number): Promise<SnapResult> {
  try {
    const url = `${OSRM_BASE}/nearest/v1/driving/${lng},${lat}?number=3`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SNAP_TIMEOUT_MS),
    });
    if (!res.ok) return { lat, lng, snapped: false };

    const data = await res.json() as OsrmNearestResponse;
    if (data.code !== "Ok" || !data.waypoints || data.waypoints.length === 0) {
      return { lat, lng, snapped: false };
    }

    const candidates = data.waypoints.filter((wp) => wp.distance <= SNAP_RADIUS);
    if (candidates.length === 0) return { lat, lng, snapped: false };

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
 */
export async function snapTrajectory(points: TrajectoryPoint[]): Promise<LatLng[]> {
  if (!points || points.length < 2) return points.map((p) => ({ lat: p.lat, lng: p.lng }));

  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const radiuses = points.map(() => SNAP_RADIUS).join(";");
    const timestamps = points
      .map((p) => Math.floor(new Date(p.timestamp || Date.now()).getTime() / 1000))
      .join(";");

    const url = `${OSRM_BASE}/match/v1/driving/${coords}?radiuses=${radiuses}&timestamps=${timestamps}&geometries=geojson&overview=full&annotations=true`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return points.map((p) => ({ lat: p.lat, lng: p.lng }));

    const data = await res.json() as OsrmMatchResponse;

    if (data.code !== "Ok" || !data.matchings || data.matchings.length === 0) {
      console.warn("[snapTrajectory] No match found — returning raw points");
      return points.map((p) => ({ lat: p.lat, lng: p.lng }));
    }

    const snappedCoords = data.matchings[0].geometry.coordinates;
    return snappedCoords.map((c) => ({ lat: c[1], lng: c[0] }));
  } catch (err) {
    console.warn("[snapTrajectory] Failed:", (err as Error).message);
    return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  }
}
